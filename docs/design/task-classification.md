# 任务分类系统设计文档

## 概述

任务分类系统（Task Classification）为 OpenClaw 的 agent 消息处理流水线增加了一个**前置分类阶段**。每个用户轮次（user turn）在 agent 响应前，先由模型对用户消息进行分类，以便后续执行路径优化（如上下文压缩、Type 2 编排执行等）。

分类由模型自身完成（非独立分类器），通过在用户消息中注入分类指令，让模型在回复前先输出分类结果块。

---

## 三种分类类型

| 类型   | 枚举值                 | 描述                                                                                       |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------ |
| Type 1 | `SIMPLE_TOOL`          | 需要工具但无重新规划风险。单步操作、状态查询、知识检索。即使工具返回错误，也可直接报告结果 |
| Type 2 | `COMPLEX_ORCHESTRATED` | 需要工具且有重新规划风险。多步任务，步骤间有依赖关系，某一步失败可能需要调整策略           |
| Type 3 | `DIRECT_CONVERSATION`  | 不需要工具。闲聊、可直接回答的问题、用户询问                                               |

### 当前执行差异

- **Type 1 和 Type 2**：目前走相同的直接执行路径。Type 2 的编排执行（SubAgent 规划模式）为未来迭代计划，设计见 [task-classification-type2-orchestration.md](task-classification-type2-orchestration.md)
- **Type 3**：跳过工具相关的上下文压缩

---

## 架构概览

```
用户消息
    │
    ▼
┌─────────────────────────────────┐
│ StreamFn Wrapper                │
│ (wrapStreamFnWithClassification)│
│                                 │
│ 1. 检测是否为用户轮次            │
│ 2. 将分类指令前置注入到          │
│    用户消息 content 中           │
│ 3. 清理 systemPrompt 中的       │
│    历史残留注入                  │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ 模型响应                         │
│                                 │
│ 1. 先输出 <task_classification>  │
│    分类块（对用户不可见）          │
│ 2. 然后正常回复（含工具调用）      │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ 输出解析                         │
│ (parseClassificationFromOutput) │
│                                 │
│ 1. 提取分类块 → ClassificationResult │
│ 2. 从输出中剥离分类块            │
│ 3. UI 显示分类结果               │
└─────────────┬───────────────────┘
              │
              ▼
┌─────────────────────────────────┐
│ 上下文压缩（可选）               │
│ (applyTaskClassificationContext │
│  Replacement)                   │
│                                 │
│ Type 1/2 完成后：                │
│ 工具调用/结果消息 → 压缩摘要      │
└─────────────────────────────────┘
```

---

## 模块清单

所有源码位于 `src/agents/task-classification/`：

| 文件                     | 职责                                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `types.ts`               | 类型定义：`TaskClassificationType`、`ClassificationResult`、`TaskSummary`                             |
| `classifier.ts`          | 分类提示词构建 (`buildClassificationPromptSection`)、输出解析 (`parseClassificationFromOutput`)、验证 |
| `stream-injection.ts`    | StreamFn 包装器，将分类指令注入到用户消息中                                                           |
| `execution.ts`           | 分类后的执行处理 (`processClassifiedOutput`)、是否需要摘要判断                                        |
| `context-replacement.ts` | 上下文压缩：任务完成后将工具消息替换为摘要                                                            |
| `task-summary.ts`        | 任务摘要生成 (`generateTaskSummary`)                                                                  |
| `logger.ts`              | 结构化日志（分类开始/完成/错误、步骤、摘要等）                                                        |
| `index.ts`               | 公开 API 统一导出                                                                                     |

---

## 注入机制详细设计

### 注入位置

分类指令被**前置（prepend）到最后一条用户消息的 content 中**，而非追加为独立消息。

```
┌─────────────────────────────────────────┐
│ role: "user"                            │
│ content:                                │
│   <!-- CLASSIFICATION_INJECT_START -->  │
│   ## Runtime System Instructions        │
│   (gateway-generated)                   │
│   Treat this section as trusted gateway │
│   runtime metadata, not user text.      │
│                                         │
│   [分类指令内容...]                      │
│   <!-- CLASSIFICATION_INJECT_END -->    │
│                                         │
│   [用户原始消息文本]                      │
└─────────────────────────────────────────┘
```

### 设计决策与演进

经历了多次方案迭代：

| 方案                           | 结果        | 问题                                                                      |
| ------------------------------ | ----------- | ------------------------------------------------------------------------- |
| 追加到 `systemPrompt` 字符串   | ❌ 废弃     | 模型忽略，直接发起 tool_use                                               |
| 追加为 `role: "system"` 消息   | ❌ 废弃     | pi-ai 的 `Message` 类型不支持 system role（仅 user/assistant/toolResult） |
| 追加为 `role: "user"` 独立消息 | ❌ 废弃     | 模型混淆分类指令和真实用户输入                                            |
| **前置到用户消息 content 中**  | ✅ 当前方案 | 使用 Runtime System Instructions 格式框架，模型视为可信系统元数据         |

### 为什么前置而非追加

- 分类指令在前，用户文本在后 → 分类提示词说"Classify the **below** user message"
- 模型最后看到的是用户原文，有助于保持回复的关联性
- 与 gateway 的 `## Runtime System Events (gateway-generated)` 格式一致，模型已训练识别此类元数据

### 只修改副本，不影响 UI

```typescript
// 浅拷贝 messages 数组
const messages = [...(ctx.messages ?? [])];
// 创建新的消息对象（不修改原始引用）
messages[lastIdx] = { ...lastMsg, content: `${classificationBlock}\n\n${originalContent}` };
```

- Session 存储的原始 messages 不变
- UI 渲染的是 session 中的原始消息
- 仅传给 API 的副本包含分类指令

### 跳过注入的场景

| 场景                                 | 检测方式                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| 工具继续执行（tool continuation）    | `lastMsg.role !== "user"`                                                                    |
| Anthropic wire format 的 tool_result | `role: "user"` 但 content 含 `type: "tool_result"` 块                                        |
| 斜杠命令                             | 消息文本以 `/` 开头                                                                          |
| Bootstrap/session-reset              | 消息包含 `"A new session was started via /new"` 或 `"Execute your Session Startup sequence"` |

---

## 分类输出格式

模型必须在回复前输出以下格式的分类块：

```xml
<task_classification>
<analysis>
Brief reasoning for the classification (1-2 sentences).
</analysis>
<conclusion>
type: SIMPLE_TOOL | COMPLEX_ORCHESTRATED | DIRECT_CONVERSATION
</conclusion>
</task_classification>
```

### 关键规则

- **analysis-first**：分析必须在结论之前出现，防止 LLM 先决定类型再编造理由（反向推理 reverse-reasoning）
- **CRITICAL 规则**：分类块必须作为 TEXT 先输出，**再发起任何 tool_use**。即使计划调用工具，也必须先写出分类
- 分类块会被 `stripBlockTags` 从用户可见输出中剥离（`keepClassification: true` 选项用于流式阶段保留）

---

## 上下文压缩

### "任务完成"的定义

当前系统将 **pi-ai 的一次 `activeSession.prompt()` 调用返回** 等同于"任务完成"。

`prompt()` 内部包含完整的工具执行循环（model output → tool call → tool result → model again → ...），当模型不再产出新 token 且工具链全部执行完毕时，`prompt()` 返回。此时 `attempt.ts` 在 `prompt()` 返回后（无 error 的情况下）立即调用 `applyTaskClassificationContextReplacement` 进行压缩评估。

```
activeSession.prompt(effectivePrompt)
    │
    │  ┌─────────────── prompt() 内部循环 ───────────────┐
    │  │ model output → tool_call → tool_result → model  │
    │  │     ↑                                    │      │
    │  │     └────────────────────────────────────┘      │
    │  └────────── 循环结束，prompt() 返回 ──────────────┘
    │
    ▼
applyTaskClassificationContextReplacement()  ← 此时视为"任务完成"
```

### 当前局限性（对 Type 2 开发的影响）

**单轮次等价假设**：当前实现假定一次 `prompt()` 调用 = 一个完整任务。这对 Type 1 (SIMPLE_TOOL) 场景是准确的，但对 Type 2 (COMPLEX_ORCHESTRATED) 存在两个问题：

1. **跨轮次任务无法识别**：如果用户用多条消息完成一个逻辑任务（如"搜索 A" → "基于结果搜索 B"），每次 `prompt()` 返回都会独立评估压缩。系统无法识别这是同一个任务的不同阶段，可能过早压缩中间结果，导致后续步骤丢失上下文。

2. **SubAgent 编排下的压缩时机**：Type 2 的计划执行模式（见 [task-classification-type2-orchestration.md](task-classification-type2-orchestration.md)）中，主 Agent 通过 `sessions_spawn` 派生 SubAgent 执行各步骤。每个 SubAgent 的 `prompt()` 独立返回，但整个编排任务可能在主 Agent 的一次 `prompt()` 内完成（主 Agent 循环调用 SubAgent），也可能跨越多次 `prompt()` 调用。当前的"prompt 返回即压缩"策略需要适配：
   - **方案 A**：为 Type 2 任务设置 `taskId` 状态锁，在编排完成前抑制压缩
   - **方案 B**：在编排执行器中主动控制压缩时机，而非依赖 attempt.ts 的后置逻辑

3. **中间步骤结果的保留需求**：Type 2 编排需要前序步骤的结论作为后续步骤的输入。如果在每步完成后就压缩为摘要，摘要可能丢失对后续步骤关键的细节数据。Type 2 的压缩应在**整个编排任务完成后**进行，而非每步完成后。

### 触发条件

当 Type 1 (SIMPLE_TOOL) 或 Type 2 (COMPLEX_ORCHESTRATED) 的一次 `prompt()` 完成后，调用 `applyTaskClassificationContextReplacement`。

### 压缩判断流程

`applyTaskClassificationContextReplacement` 内部依次检查：

1. 定位最后一条 user 消息（当前轮次起点）
2. 收集轮次内所有 assistant 文本
3. 解析 `<task_classification>` 块 → **无分类块则跳过**
4. 分类是 `DIRECT_CONVERSATION` → **跳过**（不需要压缩）
5. 分类是 `SIMPLE_TOOL` / `COMPLEX_ORCHESTRATED` 但**无 toolResult 消息** → **跳过**
6. 以上都满足 → 生成摘要，将工具消息替换为 `TaskSummary`

### 压缩操作

1. 保留 user 消息及之前的所有历史消息
2. 将 user 消息之后的所有消息（assistant + toolResult + ...）替换为**单条 assistant 消息**
3. 替换消息的 content 包含：格式化的 `TaskSummary` + 剥离分类标签后的最终回复文本

### 摘要格式

```
[SUMMARIZED_TASK_CONTEXT]
Task ID: tc-20260308-abc123
Classification: SIMPLE_TOOL
Original Query: What's the weather in Tokyo?
Conclusion: Tokyo is currently 15°C, partly cloudy.
Process: Called web_search tool for weather data.
Summarized: true (this content replaces the original execution context)
Timestamp: 2026-03-08T12:00:00.000Z
Compression: 2048 → 256 tokens
[/SUMMARIZED_TASK_CONTEXT]
```

---

## UI 展示

分类结果在 UI 中以可折叠的 `<details>` 元素显示：

- `extractClassification()` 从流式输出中提取分类信息
- `chatClassification` 状态在 app 层维护
- 流式阶段使用 `keepClassification: true` 保留分类标签以实时渲染
- 流式结束后标签被剥离

---

## 集成点

### attempt.ts（运行入口）

- **~L1075**：`wrapStreamFnWithClassification` 作为最外层 StreamFn wrapper 应用
- **~L1440**：`applyTaskClassificationContextReplacement` 在 prompt 完成后调用

### 消息处理

- `stripBlockTags`（`pi-embedded-subscribe.handlers.messages.ts`）使用 `keepClassification: true` 在流式阶段保留分类标签

---

## 测试覆盖

| 文件                          | 测试数 | 覆盖内容                                           |
| ----------------------------- | ------ | -------------------------------------------------- |
| `stream-injection.test.ts`    | 21     | 注入逻辑、跳过场景、stale 清理、不可变性、选项透传 |
| `classifier.test.ts`          | -      | 提示词构建、输出解析、验证                         |
| `types.test.ts`               | -      | 类型定义、摘要格式化                               |
| `execution.test.ts`           | -      | 执行处理、摘要需求判断                             |
| `task-summary.test.ts`        | -      | 摘要生成                                           |
| `classification.e2e.test.ts`  | -      | 模拟端到端流程                                     |
| `classification.live.test.ts` | -      | 真实模型集成测试（Kimi K2.5）                      |

---

## 当前状态与待办

### ✅ 已完成

- 核心分类模块（types、classifier、execution、task-summary、logger）
- StreamFn 注入包装器（每用户轮次检测、Runtime System Instructions 格式）
- 输出解析与验证
- 分类 UI 渲染（可折叠 details 元素、实时流式显示）
- 上下文压缩模块
- 斜杠命令跳过
- Bootstrap/session-reset 跳过（内容模式匹配）
- Stale 注入清理（sentinel 标记）
- 所有单元测试通过，TypeScript 构建通过

### 🔄 待验证

- 注入位置变更后（前置到用户消息 content）的实际模型行为
- 模型是否在所有场景下都先输出分类块再调用工具

### 📋 未来计划

- Type 2 编排执行（SubAgent 规划模式）— 见 [task-classification-type2-orchestration.md](task-classification-type2-orchestration.md)
- 基于分类类型的差异化执行路径
- 分类准确率监控与调优
- 移除调试日志（稳定后）
