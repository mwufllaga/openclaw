# Type 2 复杂任务编排执行方案

## 概述

当任务被分类为 `COMPLEX_ORCHESTRATED` (Type 2) 时，系统将使用**显式规划 + SubAgent 执行**模式。编排采用**状态机驱动架构**——不存在字面上的 `while` 循环，每个 agent turn 独立执行，由 SubAgent announce 事件串联。Plan 持久化在磁盘 JSON 文件中，作为唯一权威数据源；模型只能看到只读视图，所有变更由运行时代码验证后写入。

---

## 核心设计原则

1. **规划先行**: 在执行任何步骤前，先在同一轮 `prompt()` 中生成分类 + 完整执行计划
2. **步骤隔离**: 每个步骤作为独立 SubAgent 执行，上下文受控
3. **进度感知**: Agent 始终通过 System Prompt 注入感知当前进度和历史结果
4. **决策点支持**: 关键决策点等待用户确认
5. **结果传递**: 前序步骤结论由运行时从磁盘加载并注入后续步骤上下文
6. **Plan 不可变性**: 已完成步骤只追加不可修改，剩余步骤可被 re-plan 替换
7. **Runtime 权威**: Plan 数据由运行时管理，模型通过结构化标签请求变更，运行时验证后才写入

---

## 架构决策记录

### 为什么不用字面循环？

`sessions_spawn` 是**火后不管（fire-and-forget）**的工具调用。主 Agent 调用后 `prompt()` 立即返回。SubAgent 完成后，announce 流会触发父 session 的一个**全新 agent turn**（通过 `callGateway("agent")`），走完全一样的 `runEmbeddedAttempt` 路径。因此不可能在同一个 `runEmbeddedAttempt` 内等待 SubAgent 完成再循环。

### 为什么 Plan 存磁盘独立文件？

- `SessionEntry` 是 gateway 层管理数据（存储在磁盘 JSON 文件中，只有 TypeScript 运行时代码能读写），模型完全无法直接感知，且已有 60+ 字段，不适合继续膨胀
- Plan 数据结构天然是嵌套的（steps 数组、decision points、step results），与 `SubagentRunRecord` 的 JSON 文件模式一致（参见 `src/agents/subagent-registry.store.ts`）
- 独立文件支持跨进程读取、复杂结构查询、生命周期独立管理

### 模型如何感知 Plan？

模型只能感知两样东西：**System Prompt** 和 **Messages 数组**。无论 Plan 存在哪里，最终都要通过这两种途径之一注入。

Plan 通过 **System Prompt 注入只读视图**（而非通过 messages），这样 Plan 状态持续可见、不会被 compaction 截断：

```
Plan 存储 (磁盘 JSON 文件)
    │
    ├── 写入: prompt() 返回后，运行时解析模型输出的 plan → 存盘
    ├── 读取: 下一步执行前，运行时从盘读取 → 构建 system prompt 注入
    └── 更新: 步骤完成/re-plan 后，运行时更新盘上 plan
```

**存储 vs 注入是两个独立决策**——存储解决持久化问题，注入解决模型感知问题。

### SubAgent 上下文由谁构建？

Runtime 在 System Prompt 中以 **Context Bank** 形式提供所有原料（原始请求 + 已完成步骤结论 + 当前步骤 spec），Agent 自行选择和组装 `sessions_spawn({ task: "..." })` 的内容。这让 Agent 根据自身理解选择传递哪些上下文，避免 SubAgent 上下文爆炸。

### Plan 数据权威性

```
┌──────────────────────────────────────────────────┐
│  运行时（TypeScript 代码）                         │
│  = Plan State 的唯一写入者                        │
│                                                  │
│  Plan 数据 (磁盘 JSON)                            │
│  ├── completedSteps[] ← 只追加，不可修改           │
│  │   └── { stepId, result, summary, ... }        │
│  ├── currentStepIndex ← 运行时推进                │
│  └── remainingSteps[] ← 可被 re-plan 替换        │
└──────────────────┬───────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
  [注入 system prompt]    [解析模型输出]
  (只读视图)              (结构化指令)
        │                     │
        ▼                     ▼
┌───────────────────────────────────────────────┐
│  模型                                          │
│                                                │
│  能看到: plan 全貌（只读）                       │
│  能做的: 输出结构化的 re-plan 请求               │
│  不能做: 直接修改 plan 数据                      │
│                                                │
│  re-plan 输出格式:                              │
│  <plan_update>                                 │
│    { "replaceRemaining": [...new steps...] }   │
│  </plan_update>                                │
│                                                │
│  → 运行时解析后验证：                            │
│    ✓ 不涉及已完成步骤                            │
│    ✓ 新步骤结构合法                              │
│    → 才写入磁盘                                  │
└───────────────────────────────────────────────┘
```

---

## 执行流程（状态机模型）

编排不是字面循环，而是由 **announce 事件驱动的状态机**。每个 agent turn 在入口检测活跃 Plan 状态，执行对应动作：

```
Turn 1: 用户消息 → 分类 + 规划
════════════════════════════════
用户消息
    │
    ▼
wrapStreamFnWithClassification
(注入分类指令，含 Type 2 时输出 plan 的规则)
    │
    ▼
prompt() → 模型输出:
  <task_classification>
    analysis: 多步任务，步骤有依赖...
    conclusion: type: COMPLEX_ORCHESTRATED
  </task_classification>
  <execution_plan>
    { steps: [...], decisionPoints: [...] }
  </execution_plan>
  "我将分步执行这个迁移任务。计划如下：..."
    │
    ▼
prompt() 返回
    │
    ▼
运行时 (attempt.ts post-prompt):
  1. parseClassification → COMPLEX_ORCHESTRATED
  2. extractExecutionPlan → plan JSON
  3. 创建 PersistedPlan → savePlan(<stateDir>/orchestration/<taskId>.json)
  4. 跳过 context replacement (编排未完成)
  5. 更新 system prompt → 编排模式 + Context Bank + step 1 指令
  6. 再次调用 prompt() 驱动 step 1 执行
    │
    ▼

Turn 2: 执行 Step 1
════════════════════
system prompt 包含:
  [ORCHESTRATED_EXECUTION_MODE]
  == Plan 只读视图 ==
  → CURRENT: Step 1 - Scan for require() statements
  ○ PENDING: Step 2/3/4 ...
  == CONTEXT BANK ==
  [Original Request] 用户原始消息
  == SUBAGENT TASK INSTRUCTIONS ==
  ...
  [/ORCHESTRATED_EXECUTION_MODE]
    │
    ▼
prompt() → 模型:
  调用 sessions_spawn({
    task: "Step 1: Scan the codebase for require()...",
    label: "step_1", mode: "run"
  })
  → 工具返回 { status: "accepted" }
  → 模型输出: "已派发步骤 1，等待执行结果。"
    │
    ▼
prompt() 返回
运行时: plan.status = 'executing', savePlan()
agent turn 结束

    ··· SubAgent 独立执行 ···
    SubAgent 完成 → announce 流触发

Turn 3: announce 触发 — step 1 结果到达
════════════════════════════════════════
announce 调用 callGateway("agent") → 全新 agent turn
incoming message 含 SubAgent 结果:
  "[Internal task completion event]
   status: completed successfully
   Result: Found 15 files with require()..."
    │
    ▼
运行时 (turn 入口):
  1. 检测 sessionKey 有活跃 plan → loadPlan()
  2. 从 incoming message 提取 SubAgent 结果
  3. completeStep(step_1, { success: true, result: "..." })
     → completedSteps.push(step1Result)  // 不可变追加
     → remainingSteps.shift()
     → currentStepIndex++
     → savePlan()
  4. 检查 decisionPoint → 无
  5. 重建 system prompt:
     ✓ COMPLETED: Step 1 (Found 15 files...)
     → CURRENT: Step 2 - Convert to imports
     ○ PENDING: Step 3/4 ...
     CONTEXT BANK 含 step 1 结论
    │
    ▼
prompt() → 模型:
  调用 sessions_spawn({ task: "Step 2: ..." })
  → "已派发步骤 2"
    │
    ▼
prompt() 返回 ... (announce 驱动继续)

Turn N: 所有步骤完成
═══════════════════
运行时:
  1. loadPlan() → remainingSteps.length === 0
  2. system prompt: "所有步骤已完成，请总结"
    │
    ▼
prompt() → 模型输出最终总结
    │
    ▼
运行时:
  1. plan.status = 'completed', savePlan()
  2. applyTaskClassificationContextReplacement()
     → 一次性压缩全部中间消息为摘要
```

---

## Plan 持久化设计

### 存储位置

```
<stateDir>/orchestration/<taskId>.json

示例: ~/.openclaw/orchestration/task_abc123.json
```

参照 `SubagentRunRecord` 的 `<stateDir>/subagents/runs.json` 模式（见 `src/agents/subagent-registry.store.ts`）。

### 数据结构

Plan 分为**不可变区**和**可变区**，运行时对其操作有严格规则：

```typescript
// src/agents/task-classification/orchestration/types.ts

interface PersistedPlan {
  // ===== 元数据 =====
  taskId: string; // 唯一任务标识
  sessionKey: string; // 关联的主 Agent session
  taskSummary: string; // 任务简述
  originalQuery: string; // 用户原始消息（用于 SubAgent Context Bank）
  createdAt: number;
  updatedAt: number;

  // ===== 状态 =====
  status: "executing" | "awaiting_decision" | "completed" | "failed" | "aborted";

  // ===== 不可变区 — 只追加，不可修改 =====
  completedSteps: CompletedStep[];
  // 运行时规则:
  //   - 只能 push()，不可修改已有条目
  //   - 写入前校验: 与磁盘上版本比对，已有条目不变

  // ===== 可变区 — 可被 re-plan 替换 =====
  currentStepIndex: number; // 指向 remainingSteps[0], 只递增
  remainingSteps: PlanStep[]; // 可被 re-plan 整体替换
  decisionPoints: DecisionPoint[]; // 随 remainingSteps 一起更新

  // ===== 审计日志 =====
  changeLog: PlanChange[]; // 记录所有变更操作
}

interface CompletedStep {
  stepId: string;
  stepNumber: number;
  description: string;
  status: "completed" | "failed";
  startedAt: number;
  completedAt: number;
  durationMs: number;

  // 执行信息
  subagentSessionKey?: string;
  subagentRunId?: string;

  // 结果 — 一旦写入不可修改
  success: boolean;
  summary: string; // 结果摘要（用于日志和用户通知）
  outputForNextSteps: string; // 传递给后续步骤的精简结论
  rawResult?: unknown; // SubAgent 原始返回
}

interface PlanStep {
  stepId: string;
  description: string;
  inputSpec: string; // 该步骤需要的输入
  expectedOutput: string; // 该步骤的预期输出
  dependsOn: string[]; // 依赖的前序步骤 ID
  complexity: "low" | "medium" | "high";
  requiresConfirmation: boolean;
}

interface DecisionPoint {
  afterStepId: string; // 在哪个步骤后触发
  reason: string; // 需要确认的原因
  options: string[]; // 用户可选项
  defaultAction: string; // 默认选项
}

interface PlanChange {
  type: "step_completed" | "step_failed" | "replan" | "decision_resolved" | "aborted";
  timestamp: number;
  reason: string;
  diff?: {
    removedSteps?: string[]; // 被移除的 stepId
    addedSteps?: string[]; // 新增的 stepId
  };
}
```

### 不可变性模型

| 区域               | 包含什么               | 可变性                    | 操作          |
| ------------------ | ---------------------- | ------------------------- | ------------- |
| `completedSteps`   | 已执行完的步骤及其结果 | **不可变**（只追加）      | `push()` only |
| `currentStepIndex` | 当前步骤序号           | **只递增**                | `++` only     |
| `remainingSteps`   | 未执行的步骤列表       | **可整体替换**            | `= newSteps`  |
| `decisionPoints`   | 未来的决策点           | **随 remaining 一起更新** | `= newPoints` |
| `changeLog`        | 所有变更的审计日志     | **只追加**                | `push()` only |

### Plan Store 实现

```typescript
// src/agents/task-classification/orchestration/plan-store.ts

import { loadJsonFile, saveJsonFile } from "../../util/json-file.js";

const ORCHESTRATION_DIR = "orchestration";

function getPlanPath(stateDir: string, taskId: string): string {
  return path.join(stateDir, ORCHESTRATION_DIR, `${taskId}.json`);
}

function savePlan(stateDir: string, plan: PersistedPlan): void {
  const filePath = getPlanPath(stateDir, plan.taskId);

  // 不可变性校验: 如果磁盘上已有 plan，检查 completedSteps 未被修改
  if (fs.existsSync(filePath)) {
    const existing = loadJsonFile<PersistedPlan>(filePath);
    if (existing) {
      validateCompletedStepsImmutability(existing.completedSteps, plan.completedSteps);
    }
  }

  plan.updatedAt = Date.now();
  ensureDir(path.dirname(filePath));
  saveJsonFile(filePath, plan);
}

function loadPlan(stateDir: string, taskId: string): PersistedPlan | null {
  const filePath = getPlanPath(stateDir, taskId);
  return loadJsonFile<PersistedPlan>(filePath) ?? null;
}

function deletePlan(stateDir: string, taskId: string): void {
  const filePath = getPlanPath(stateDir, taskId);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function listActivePlans(stateDir: string): PersistedPlan[] {
  const dir = path.join(stateDir, ORCHESTRATION_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadJsonFile<PersistedPlan>(path.join(dir, f)))
    .filter(
      (p): p is PersistedPlan => p !== null && p.status !== "completed" && p.status !== "aborted",
    );
}

/**
 * 校验已完成步骤的不可变性:
 * 已有的 completedSteps 条目不可被删除或修改，只能追加新条目。
 */
function validateCompletedStepsImmutability(
  existing: CompletedStep[],
  incoming: CompletedStep[],
): void {
  if (incoming.length < existing.length) {
    throw new Error(
      `Cannot remove completed steps: existing ${existing.length}, incoming ${incoming.length}`,
    );
  }
  for (let i = 0; i < existing.length; i++) {
    if (
      existing[i].stepId !== incoming[i].stepId ||
      existing[i].summary !== incoming[i].summary ||
      existing[i].success !== incoming[i].success
    ) {
      throw new Error(`Cannot modify completed step ${existing[i].stepId}: immutability violation`);
    }
  }
}
```

---

## Plan 变更操作（运行时控制）

所有 Plan 变更由运行时代码执行，模型无法直接修改。

```typescript
// src/agents/task-classification/orchestration/plan-mutations.ts

/**
 * 记录步骤完成（只追加，不可变）
 * 将当前步骤移入 completedSteps，递增 currentStepIndex
 */
function completeStep(
  plan: PersistedPlan,
  stepId: string,
  result: {
    success: boolean;
    summary: string;
    outputForNextSteps: string;
    rawResult?: unknown;
    subagentSessionKey?: string;
    subagentRunId?: string;
    startedAt: number;
  },
): void {
  const stepIndex = plan.remainingSteps.findIndex((s) => s.stepId === stepId);
  if (stepIndex === -1) {
    throw new Error(`Step ${stepId} not found in remainingSteps`);
  }
  if (stepIndex !== 0) {
    throw new Error(`Step ${stepId} is not the current step (index ${stepIndex})`);
  }

  const step = plan.remainingSteps[0];
  const now = Date.now();

  // 追加到不可变区
  plan.completedSteps.push({
    stepId: step.stepId,
    stepNumber: plan.currentStepIndex + 1,
    description: step.description,
    status: result.success ? "completed" : "failed",
    startedAt: result.startedAt,
    completedAt: now,
    durationMs: now - result.startedAt,
    success: result.success,
    summary: result.summary,
    outputForNextSteps: result.outputForNextSteps,
    rawResult: result.rawResult,
    subagentSessionKey: result.subagentSessionKey,
    subagentRunId: result.subagentRunId,
  });

  // 从可变区移除
  plan.remainingSteps.shift();
  plan.currentStepIndex++;

  // 审计日志
  plan.changeLog.push({
    type: result.success ? "step_completed" : "step_failed",
    timestamp: now,
    reason: result.summary,
  });

  // 更新状态
  if (plan.remainingSteps.length === 0) {
    plan.status = "completed";
  }
}

/**
 * 替换剩余步骤（Re-plan）
 * 已完成步骤不受影响，只替换 remainingSteps + decisionPoints。
 */
function replanRemaining(
  plan: PersistedPlan,
  newSteps: PlanStep[],
  newDecisionPoints: DecisionPoint[],
  reason: string,
): void {
  const removedSteps = plan.remainingSteps.map((s) => s.stepId);
  const addedSteps = newSteps.map((s) => s.stepId);

  // 校验: 新步骤不能引用已完成步骤的 stepId
  const completedIds = new Set(plan.completedSteps.map((s) => s.stepId));
  for (const step of newSteps) {
    if (completedIds.has(step.stepId)) {
      throw new Error(`Re-plan step ${step.stepId} conflicts with completed step`);
    }
  }

  plan.remainingSteps = newSteps;
  plan.decisionPoints = newDecisionPoints;

  plan.changeLog.push({
    type: "replan",
    timestamp: Date.now(),
    reason,
    diff: { removedSteps, addedSteps },
  });
}

/**
 * 中止 Plan
 */
function abortPlan(plan: PersistedPlan, reason: string): void {
  plan.status = "aborted";
  plan.changeLog.push({
    type: "aborted",
    timestamp: Date.now(),
    reason,
  });
}
```

---

## 阶段详解

### 阶段 1: 分类 + 规划（同一轮 prompt）

#### 触发条件

- 用户发送消息
- 分类指令已注入（由 `wrapStreamFnWithClassification` 处理）

#### 分类指令扩展

在 `classifier.ts` 的 `buildClassificationPromptSection()` 中增加 Type 2 规划规则：

```
If you classify as COMPLEX_ORCHESTRATED, you MUST also output an <execution_plan> block
immediately after the <task_classification> block, BEFORE any tool_use.

<execution_plan>
{
  "taskSummary": "Brief description of the overall task",
  "steps": [
    {
      "stepId": "step_1",
      "description": "What this step accomplishes",
      "inputSpec": "What information/context this step needs",
      "expectedOutput": "What this step should produce",
      "dependsOn": [],
      "complexity": "low|medium|high",
      "requiresConfirmation": false
    }
  ],
  "decisionPoints": [
    {
      "afterStepId": "step_2",
      "reason": "Why user confirmation is needed here",
      "options": ["Option 1", "Option 2"],
      "defaultAction": "Option 1"
    }
  ]
}
</execution_plan>

CRITICAL for COMPLEX_ORCHESTRATED:
- Output <task_classification> FIRST, then <execution_plan>, then your text reply
- Do NOT call any tools in this turn — only output the plan
- The plan will be extracted and you will be guided to execute step by step
```

#### 运行时 Plan 提取（attempt.ts post-prompt）

```typescript
// attempt.ts ~L1441, prompt() 返回后:

const classification = parseClassificationFromOutput(assistantOutput);

if (classification?.type === TaskClassificationType.COMPLEX_ORCHESTRATED) {
  const planJson = extractExecutionPlan(assistantOutput);
  if (planJson) {
    // 创建 PersistedPlan
    const plan: PersistedPlan = {
      taskId: generateTaskId(),
      sessionKey: params.sessionKey,
      taskSummary: planJson.taskSummary,
      originalQuery: userMessage,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "executing",
      completedSteps: [],
      currentStepIndex: 0,
      remainingSteps: planJson.steps,
      decisionPoints: planJson.decisionPoints ?? [],
      changeLog: [],
    };

    // 持久化
    savePlan(stateDir, plan);
    planningLog.info("plan-created", { taskId: plan.taskId, steps: plan.remainingSteps.length });

    // 跳过 context replacement (编排未完成)
    // 更新 system prompt → 编排模式
    applySystemPromptOverrideToSession(activeSession, buildOrchestratedSystemPrompt(plan));

    // 再次调用 prompt() 驱动 step 1 执行
    await activeSession.prompt("Execute the current step as instructed.");

    // prompt() 返回后由正常 announce 流继续驱动
    return;
  }
}

// 非 Type 2: 走现有 context replacement 逻辑
applyTaskClassificationContextReplacement(activeSession.messages, sessionKey);
```

---

### 阶段 2: 编排模式 System Prompt（Agent 约束 + Context Bank）

每个编排 turn 开始时，运行时从磁盘加载 Plan 并注入 System Prompt。模型看到的是**只读视图**。

```typescript
// src/agents/task-classification/orchestration/prompts.ts

function buildOrchestratedSystemPrompt(plan: PersistedPlan): string {
  const currentStep = plan.remainingSteps[0];

  return `
[ORCHESTRATED_EXECUTION_MODE - MANDATORY]

You are executing a complex task that has been pre-planned.
You MUST follow the plan and use sessions_spawn for each step.

== EXECUTION PLAN (read-only, managed by runtime) ==
Task: ${plan.taskSummary}

${plan.completedSteps
  .map(
    (s) => `
[✓ COMPLETED] Step ${s.stepNumber}: ${s.description}
    Result: ${s.outputForNextSteps}
`,
  )
  .join("\n")}

${
  currentStep
    ? `
[→ CURRENT] Step ${plan.currentStepIndex + 1}: ${currentStep.description}
    Input needed: ${currentStep.inputSpec}
    Expected output: ${currentStep.expectedOutput}
    Complexity: ${currentStep.complexity}
    ${currentStep.dependsOn.length > 0 ? `Depends on: ${currentStep.dependsOn.join(", ")}` : ""}
`
    : `
All steps completed. Summarize the results.
`
}

${plan.remainingSteps
  .slice(1)
  .map(
    (s, i) => `
[○ PENDING] Step ${plan.currentStepIndex + i + 2}: ${s.description}
`,
  )
  .join("\n")}

== CONTEXT BANK (for SubAgent task construction) ==

[Original Request]
${plan.originalQuery}

${
  plan.completedSteps.length > 0
    ? `
[Completed Step Results]
${plan.completedSteps
  .map(
    (s) => `
Step ${s.stepNumber} (${s.description}):
${s.outputForNextSteps}
`,
  )
  .join("\n")}
`
    : ""
}

== SUBAGENT TASK INSTRUCTIONS ==
When calling sessions_spawn, your task parameter MUST include:
1. The step description and goal
2. Relevant context from completed steps (select what's needed, don't copy everything)
3. The expected output format:
   {
     "success": true|false,
     "result": "Main result or conclusion",
     "details": { ... },
     "nextStepContext": "Information needed for subsequent steps"
   }
4. Constraint: focus ONLY on this step, do NOT spawn further subagents

== MANDATORY RULES ==
1. You MUST use sessions_spawn to execute the current step
2. Assemble the task content yourself using the Context Bank above
3. DO NOT execute multiple steps in one sessions_spawn call
4. DO NOT skip steps or change the plan order
5. After receiving subagent result, summarize it briefly
6. If a step fails, report the failure — the runtime will handle next steps

== RE-PLAN ==
If you determine the remaining plan needs adjustment based on step results,
output a <plan_update> block. The runtime will validate and apply it.
You can ONLY modify remaining steps, NOT completed steps.

<plan_update>
{
  "reason": "Why the plan needs to change",
  "replaceRemaining": [
    { "stepId": "...", "description": "...", "inputSpec": "...",
      "expectedOutput": "...", "dependsOn": [], "complexity": "...",
      "requiresConfirmation": false }
  ],
  "newDecisionPoints": []
}
</plan_update>

[/ORCHESTRATED_EXECUTION_MODE]
`;
}
```

### SubAgent 约束 Prompt（纯函数模式）

SubAgent 的约束由 Agent 在 `sessions_spawn({ task })` 中自行组装（runtime 不劫持）。Agent 基于 Context Bank 中的原料构建 task 内容。以下为 Agent 参考的模板结构：

```typescript
// 参考模板 — Agent 在 sessions_spawn 的 task 参数中使用

`
[SUBAGENT_STEP_EXECUTION]

You are executing Step ${stepNumber} of an orchestrated task.
This is an isolated execution - treat yourself as a pure function.

== ORIGINAL USER REQUEST ==
${originalQuery}

== YOUR STEP ==
${stepDescription}

== INPUT CONTEXT ==
${inputContext}

== EXPECTED OUTPUT ==
${expectedOutput}

== CONSTRAINTS ==
1. Focus ONLY on this step's task
2. Use ONLY the provided context
3. DO NOT spawn further subagents
4. Return structured result in the expected format
5. If you cannot complete the step, explain why clearly

== OUTPUT FORMAT ==
Always return a JSON result:
{
  "success": true|false,
  "result": "Main result or conclusion",
  "details": { /* any additional data */ },
  "nextStepContext": "Information that subsequent steps may need"
}

[/SUBAGENT_STEP_EXECUTION]
`;
```

---

### 阶段 3: Turn 入口 — 步骤结果处理

每个 announce 触发的 agent turn，运行时在入口检测活跃 Plan 并处理上一步结果。

#### 运行时介入点

| 位置                                                | 时机           | 做什么                                                                                         |
| --------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `before_prompt_build` 或 `attempt.ts` prompt 调用前 | 每个 turn 入口 | 检测活跃 plan → 从 incoming message 提取上步结果 → `completeStep()` → 重建 system prompt       |
| `attempt.ts` prompt 返回后 (~L1441)                 | 每个 turn 出口 | 检测 Type 2 + plan 输出 → 首次创建 plan；或编排中 → 跳过压缩 + 检测 re-plan；或编排完成 → 压缩 |

#### Turn 入口处理逻辑

```typescript
// src/agents/task-classification/orchestration/executor.ts

/**
 * 在每个 agent turn 入口调用。
 * 如果当前 session 有活跃的 orchestration plan，进行状态机推进。
 *
 * @returns 编排模式的 system prompt override，或 null（非编排 session）
 */
async function handleOrchestrationTurnEntry(params: {
  sessionKey: string;
  incomingMessage: string;
  stateDir: string;
}): Promise<{
  systemPromptOverride: string;
  suppressClassification: boolean;
} | null> {
  // 查找该 session 的活跃 plan
  const plan = findActivePlanForSession(params.stateDir, params.sessionKey);
  if (!plan) return null;

  // 如果 plan 在等待用户决策，处理用户响应
  if (plan.status === "awaiting_decision") {
    const dp = plan.decisionPoints.find(
      (d) => d.afterStepId === plan.completedSteps[plan.completedSteps.length - 1]?.stepId,
    );
    if (dp) {
      const decision = handleUserDecisionResponse(params.incomingMessage, plan, dp);
      if (decision === "abort") {
        abortPlan(plan, "User aborted at decision point");
        savePlan(params.stateDir, plan);
        return null;
      }
      plan.status = "executing";
      savePlan(params.stateDir, plan);
    }
  } else {
    // 从 announce incoming message 提取 SubAgent 结果
    const stepResult = parseSubagentResultFromAnnounce(params.incomingMessage);

    if (stepResult) {
      // 确定刚完成的 step（remainingSteps[0] 在上一轮被 spawn 执行）
      const completedStepId = plan.remainingSteps[0]?.stepId;
      if (completedStepId) {
        // 运行时写入 completedSteps（不可变追加）
        completeStep(plan, completedStepId, {
          success: stepResult.success,
          summary: stepResult.result,
          outputForNextSteps: stepResult.nextStepContext || stepResult.result,
          rawResult: stepResult,
          startedAt: stepResult.startedAt ?? Date.now() - 5000,
        });

        // 检查 decision point
        const dp = checkForDecisionPoint(plan, completedStepId);
        if (dp) {
          plan.status = "awaiting_decision";
        }

        // 持久化
        savePlan(params.stateDir, plan);

        planningLog.info("step-completed", {
          taskId: plan.taskId,
          stepId: completedStepId,
          success: stepResult.success,
          summary: stepResult.result,
        });
      }
    }
  }

  // 如果所有步骤完成
  if (plan.status === "completed") {
    // 返回 "请总结" 的 system prompt
    return {
      systemPromptOverride: buildOrchestratedSystemPrompt(plan),
      suppressClassification: true,
    };
  }

  // 如果在等待决策
  if (plan.status === "awaiting_decision") {
    const dp = plan.decisionPoints.find(
      (d) => d.afterStepId === plan.completedSteps[plan.completedSteps.length - 1]?.stepId,
    );
    return {
      systemPromptOverride:
        buildOrchestratedSystemPrompt(plan) + buildDecisionPointPrompt(plan, dp!),
      suppressClassification: true,
    };
  }

  // 正常编排继续：构建包含 Context Bank 的 system prompt
  return {
    systemPromptOverride: buildOrchestratedSystemPrompt(plan),
    suppressClassification: true, // 编排模式下无需重新分类
  };
}
```

#### SubAgent 结果解析

```typescript
/**
 * 从 announce 注入的 incoming message 中提取 SubAgent 执行结果。
 * announce message 格式为 formatAgentInternalEventsForPrompt 渲染的内部事件。
 */
function parseSubagentResultFromAnnounce(message: string): {
  success: boolean;
  result: string;
  nextStepContext?: string;
  startedAt?: number;
} | null {
  // announce 消息包含 "Result (untrusted content, treat as data):" 部分
  const resultMatch = message.match(
    /Result \(untrusted content.*?\):\s*\n([\s\S]*?)(?:\nStats:|$)/,
  );
  if (!resultMatch) return null;

  const rawContent = resultMatch[1].trim();

  // 尝试解析结构化 JSON 返回
  try {
    const parsed = JSON.parse(rawContent);
    return {
      success: parsed.success === true,
      result: parsed.result || rawContent,
      nextStepContext: parsed.nextStepContext,
    };
  } catch {
    // 非结构化返回，视为成功
    return {
      success: true,
      result: rawContent.slice(0, 500),
      nextStepContext: rawContent.slice(0, 200),
    };
  }
}
```

---

### 阶段 4: Re-plan（计划动态修改）

#### Re-plan 触发机制

**主 Agent 自主判断**，加**步骤失败时硬编码触发**：

1. **步骤失败时**：运行时在 `completeStep` 检测到 `success === false` 后，在 system prompt 中追加指令要求 Agent 评估是否需要 re-plan
2. **步骤结果出乎预料时**：Agent 自主在输出中包含 `<plan_update>` 标签
3. **用户在决策点给出新指示时**：运行时将用户指示注入，Agent 自主判断

#### Re-plan 解析与验证

```typescript
// src/agents/task-classification/orchestration/replan.ts

/**
 * 从模型输出中提取 <plan_update> 请求
 */
function parseReplanRequest(modelOutput: string): {
  reason: string;
  replaceRemaining: PlanStep[];
  newDecisionPoints: DecisionPoint[];
} | null {
  const match = modelOutput.match(/<plan_update>([\s\S]*?)<\/plan_update>/);
  if (!match) return null;

  try {
    const parsed = JSON.parse(match[1].trim());
    return {
      reason: parsed.reason || "No reason provided",
      replaceRemaining: parsed.replaceRemaining || [],
      newDecisionPoints: parsed.newDecisionPoints || [],
    };
  } catch {
    planningLog.warn("replan-parse-error", { raw: match[1].slice(0, 200) });
    return null;
  }
}

/**
 * 验证 re-plan 请求的合法性
 */
function validateReplanRequest(
  plan: PersistedPlan,
  request: { replaceRemaining: PlanStep[]; newDecisionPoints: DecisionPoint[] },
  maxStepsPerPlan: number,
): { valid: boolean; error?: string } {
  // 1. 新步骤不能引用已完成步骤的 stepId
  const completedIds = new Set(plan.completedSteps.map((s) => s.stepId));
  for (const step of request.replaceRemaining) {
    if (completedIds.has(step.stepId)) {
      return { valid: false, error: `Step ${step.stepId} conflicts with completed step` };
    }
  }

  // 2. 步骤总数不超过限制
  const totalSteps = plan.completedSteps.length + request.replaceRemaining.length;
  if (totalSteps > maxStepsPerPlan) {
    return { valid: false, error: `Total steps ${totalSteps} > max ${maxStepsPerPlan}` };
  }

  // 3. 必填字段检查
  for (const step of request.replaceRemaining) {
    if (!step.stepId || !step.description) {
      return { valid: false, error: `Step missing required fields: stepId, description` };
    }
  }

  return { valid: true };
}
```

#### Re-plan 应用流程

```typescript
// 在 turn 出口（prompt 返回后）:

const replanRequest = parseReplanRequest(assistantOutput);
if (replanRequest) {
  const validation = validateReplanRequest(plan, replanRequest, maxStepsPerPlan);
  if (validation.valid) {
    replanRemaining(
      plan,
      replanRequest.replaceRemaining,
      replanRequest.newDecisionPoints,
      replanRequest.reason,
    );
    savePlan(stateDir, plan);
    planningLog.info("replan-applied", {
      taskId: plan.taskId,
      reason: replanRequest.reason,
      newStepCount: replanRequest.replaceRemaining.length,
    });
  } else {
    planningLog.warn("replan-rejected", {
      taskId: plan.taskId,
      error: validation.error,
    });
  }
}
```

---

### 阶段 5: 决策点处理

#### 决策点检测

```typescript
function checkForDecisionPoint(plan: PersistedPlan, completedStepId: string): DecisionPoint | null {
  return plan.decisionPoints.find((dp) => dp.afterStepId === completedStepId) || null;
}
```

#### 决策点处理流程

当检测到决策点时，编排暂停：

1. `plan.status = 'awaiting_decision'`，`savePlan()`
2. System prompt 中追加决策引导内容
3. Agent 在此 turn 输出决策请求给用户，`prompt()` 返回
4. 用户的下一条消息将触发新的 agent turn

```typescript
function buildDecisionPointPrompt(plan: PersistedPlan, dp: DecisionPoint): string {
  return `

== DECISION POINT ==
A decision point has been reached after step "${dp.afterStepId}".

Reason: ${dp.reason}

Present the following options to the user and ask them to choose:
${dp.options.map((opt, i) => `${i + 1}. ${opt}`).join("\n")}

Default: ${dp.defaultAction}

Wait for user response before proceeding. Do NOT execute the next step.
`;
}
```

#### 用户响应处理

当用户回复到达时，运行时在 turn 入口检测到 `plan.status === 'awaiting_decision'`：

```typescript
function handleUserDecisionResponse(
  userMessage: string,
  plan: PersistedPlan,
  decisionPoint: DecisionPoint,
): "proceed" | "replan" | "abort" {
  const trimmed = userMessage.trim();

  // 数字选择
  const numMatch = trimmed.match(/^(\d+)$/);
  if (numMatch) {
    const index = parseInt(numMatch[1], 10) - 1;
    if (index >= 0 && index < decisionPoint.options.length) {
      plan.changeLog.push({
        type: "decision_resolved",
        timestamp: Date.now(),
        reason: `Selected: ${decisionPoint.options[index]}`,
      });
      planningLog.info("decision-point-resolved", {
        taskId: plan.taskId,
        afterStep: decisionPoint.afterStepId,
        selectedOption: decisionPoint.options[index],
      });
      return "proceed";
    }
  }

  // 中止指令
  if (/^(stop|abort|cancel|取消|停止)/i.test(trimmed)) {
    planningLog.info("decision-point-aborted", {
      taskId: plan.taskId,
      afterStep: decisionPoint.afterStepId,
    });
    return "abort";
  }

  // 自定义指令 → 让 Agent 判断是否需要 re-plan
  plan.changeLog.push({
    type: "decision_resolved",
    timestamp: Date.now(),
    reason: `Custom instruction: ${trimmed.slice(0, 200)}`,
  });
  return "replan"; // Agent 将在 system prompt 中看到用户指示
}
```

---

## 上下文压缩适配

### 编排期间抑制压缩

当前 `applyTaskClassificationContextReplacement` 在每次 `prompt()` 返回后调用。Type 2 编排期间必须抑制，直到整个编排完成。

```typescript
// 修改 context-replacement.ts:

function applyTaskClassificationContextReplacement(
  messages: Message[],
  sessionKey: string,
  stateDir: string, // 新增参数
): ContextReplacementResult {
  // 检查是否有活跃的编排 plan
  const activePlan = findActivePlanForSession(stateDir, sessionKey);
  if (activePlan && activePlan.status !== "completed" && activePlan.status !== "aborted") {
    // 编排进行中，抑制压缩
    return { replaced: false, messages };
  }

  // 原有逻辑...
}
```

### 编排完成后一次性压缩

编排完成后（`plan.status === 'completed'`），将所有中间消息（多个 turn 的 assistant + toolResult + announce messages）替换为单条摘要，引用磁盘 Plan 中的步骤结论：

```
[SUMMARIZED_TASK_CONTEXT]
Task ID: task_abc123
Classification: COMPLEX_ORCHESTRATED
Original Query: 帮我把这个项目从 CommonJS 迁移到 ESM
Conclusion: Migration completed. 15 files converted, package.json updated.
Process: 4-step orchestrated execution
  Step 1: Scanned codebase, found 15 files with require()
  Step 2: Converted 47 require statements to imports
  Step 3: Updated package.json with type: module
  Step 4: Verified no syntax errors
Summarized: true
Timestamp: 2026-03-08T12:00:00.000Z
Compression: 8192 → 512 tokens
[/SUMMARIZED_TASK_CONTEXT]
```

---

## 集成点

### attempt.ts（运行入口）

| 位置            | 操作                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| ~L1075          | `wrapStreamFnWithClassification` 作为最外层 StreamFn wrapper（已有）                                                        |
| prompt() 调用前 | `handleOrchestrationTurnEntry()` — 检测活跃 plan，处理上步结果，注入编排 system prompt                                      |
| ~L1441          | prompt() 返回后 — 首次检测 Type 2 + plan → 创建 plan + 驱动 step 1；编排中 → 跳过压缩 + 检测 re-plan；编排完成 → 一次性压缩 |

### classifier.ts

增加 Type 2 规划输出规则：分类为 `COMPLEX_ORCHESTRATED` 时要求输出 `<execution_plan>` 块，不发起 tool_use。

### stream-injection.ts

编排模式下的后续 turn 应**跳过分类指令注入**（`suppressClassification: true`），因为编排 turn 不需要重新分类。

### subagent-announce.ts → announce 流

**无需修改**。announce 的标准流程（SubAgent 完成 → `callGateway("agent")` 触发父 session 新 turn）自然驱动状态机推进。

### context-replacement.ts

增加编排状态检查：活跃 plan 期间抑制压缩。

---

## 日志规范

### 日志子系统

| 子系统 | Logger Name           | 用途                              |
| ------ | --------------------- | --------------------------------- |
| 分类   | `task-classification` | 记录任务分类决策                  |
| 规划   | `planning`            | 记录 Plan 创建、步骤执行、re-plan |
| 摘要   | `summary`             | 记录任务摘要生成                  |

### 日志事件类型

#### 分类阶段

```typescript
classificationLog.debug("classification-started", { sessionKey, inputSummary, timestamp });
classificationLog.debug("analysis-output", { sessionKey, analysis });
classificationLog.info("classification-completed", { sessionKey, result, confidence, latencyMs });
```

#### 规划阶段

```typescript
planningLog.info("plan-created", { taskId, taskSummary, totalSteps, decisionPoints, steps });
planningLog.info("step-started", { taskId, stepId, stepNumber, description });
planningLog.info("step-completed", { taskId, stepId, stepNumber, success, durationMs, summary });
planningLog.info("replan-applied", { taskId, reason, newStepCount });
planningLog.warn("replan-rejected", { taskId, error });
planningLog.info("decision-point-reached", { taskId, afterStep, reason, options });
planningLog.info("decision-point-resolved", { taskId, afterStep, selectedOption });
planningLog.info("orchestration-completed", { taskId, totalSteps, totalDurationMs });
```

#### 摘要阶段

```typescript
summaryLog.info("summary-generated", {
  taskId,
  taskType: "COMPLEX_ORCHESTRATED",
  originalTokens,
  summaryTokens,
  compressionRatio,
  stepsCompleted,
  summaryContent: { originalQuery, conclusion, processOutline },
});
```

---

## 配置项

```typescript
// src/config/types.agent-defaults.ts — 扩展 AgentTaskClassificationConfig

interface AgentTaskClassificationConfig {
  // 已有字段
  summaryPolicy?: "always" | "on-success" | "never";
  logging?: {
    level?: "debug" | "info" | "warn";
    includeAnalysis?: boolean;
    includePlanningDetails?: boolean;
    includeSummaryContent?: boolean;
  };
  analysisFirst?: {
    enforced?: boolean;
    minAnalysisLength?: number;
  };

  // 新增: Type 2 编排配置
  orchestration?: {
    maxStepsPerPlan?: number; // 单个计划最大步骤数，默认 10
    stepTimeoutSeconds?: number; // 单步超时，默认 300
    autoConfirmLowRisk?: boolean; // 低风险决策点是否自动确认，默认 false
  };
}
```

---

## 文件结构

```
src/agents/task-classification/
├── types.ts                    # 类型定义（已有）
├── classifier.ts               # 分类器 — 增加 Type 2 规划输出规则
├── stream-injection.ts         # StreamFn 注入 — 增加编排模式跳过
├── execution.ts                # 执行处理 — 增加 Type 2 编排分支
├── context-replacement.ts      # 上下文压缩 — 增加编排期间抑制
├── task-summary.ts             # 摘要生成（已有）
├── logger.ts                   # 日志（已有）
├── index.ts                    # 公开 API（已有）
│
├── orchestration/              # 新增: Type 2 编排模块
│   ├── types.ts                # PersistedPlan, CompletedStep, PlanChange
│   ├── plan-store.ts           # 磁盘读写 + 不可变性校验
│   ├── plan-mutations.ts       # completeStep, replanRemaining, abortPlan
│   ├── executor.ts             # handleOrchestrationTurnEntry, 状态机逻辑
│   ├── prompts.ts              # buildOrchestratedSystemPrompt, Context Bank
│   ├── replan.ts               # parseReplanRequest, validateReplanRequest
│   ├── decision-handler.ts     # 决策点处理
│   ├── logger.ts               # 编排日志
│   ├── plan-store.test.ts      # 存储 + 不可变性测试
│   ├── plan-mutations.test.ts  # 变更操作测试
│   ├── replan.test.ts          # re-plan 解析验证测试
│   ├── executor.test.ts        # 状态机逻辑测试
│   └── orchestration.e2e.test.ts  # 端到端测试
│
└── e2e/
    ├── classification.e2e.test.ts   # 已有
    └── classification.live.test.ts  # 已有

磁盘存储:
<stateDir>/orchestration/
├── task_abc123.json            # Plan 文件
├── task_def456.json
└── ...
```

---

## 示例场景

### 场景: 代码库迁移任务

**用户输入:**

> 帮我把这个项目从 CommonJS 迁移到 ESM，包括更新所有 import 语句和 package.json

**Turn 1 — 分类 + 规划:**

模型输出:

```xml
<task_classification>
<analysis>
此任务涉及多个文件修改，需要：1) 分析现有 require 语句，2) 转换为 import，
3) 更新 package.json 配置，4) 处理可能的兼容性问题。步骤之间有依赖关系，
转换结果可能需要人工确认。
</analysis>
<conclusion>
type: COMPLEX_ORCHESTRATED
</conclusion>
</task_classification>

<execution_plan>
{
  "taskSummary": "CommonJS to ESM migration",
  "steps": [
    {
      "stepId": "step_1",
      "description": "Scan codebase for require() statements and module.exports",
      "inputSpec": "Project root directory",
      "expectedOutput": "List of files with CommonJS patterns",
      "dependsOn": [],
      "complexity": "low",
      "requiresConfirmation": false
    },
    {
      "stepId": "step_2",
      "description": "Convert require() to import statements",
      "inputSpec": "List of files from step 1",
      "expectedOutput": "Converted import statements for each file",
      "dependsOn": ["step_1"],
      "complexity": "medium",
      "requiresConfirmation": false
    },
    {
      "stepId": "step_3",
      "description": "Update package.json with type: module",
      "inputSpec": "Current package.json",
      "expectedOutput": "Updated package.json",
      "dependsOn": [],
      "complexity": "low",
      "requiresConfirmation": false
    },
    {
      "stepId": "step_4",
      "description": "Apply all changes and verify no syntax errors",
      "inputSpec": "Converted files from step 2, updated package.json from step 3",
      "expectedOutput": "Verification result",
      "dependsOn": ["step_2", "step_3"],
      "complexity": "medium",
      "requiresConfirmation": true
    }
  ],
  "decisionPoints": [
    {
      "afterStepId": "step_2",
      "reason": "Review converted imports before applying changes",
      "options": ["Apply all changes", "Review changes file by file", "Abort migration"],
      "defaultAction": "Apply all changes"
    }
  ]
}
</execution_plan>

我将分 4 步执行这个迁移任务：
1. 扫描代码库中的 require() 语句
2. 转换为 import 语句
3. 更新 package.json
4. 验证无语法错误

我会逐步执行，在转换完成后请您确认后再应用。
```

运行时: 提取 plan → 存盘 `~/.openclaw/orchestration/task_abc123.json` → 注入编排 system prompt → 驱动 step 1

**Turn 2 — 执行 Step 1:**

模型看到编排 system prompt（含 Context Bank），调用:

```
sessions_spawn({
  task: "Step 1: Scan the codebase for require() and module.exports patterns.
    Original request: 帮我把这个项目从 CommonJS 迁移到 ESM
    Your task: Find all files that use require() or module.exports.
    Expected output: { success: bool, result: string, nextStepContext: string }",
  label: "step_1",
  mode: "run"
})
```

**Turn 3 — Step 1 结果到达（announce 触发）:**

运行时:

1. `loadPlan("task_abc123")` → plan
2. `completeStep(plan, "step_1", { success: true, summary: "Found 15 files..." })`
3. `savePlan()` → completedSteps 不可逆追加
4. 重建 system prompt: step 1 ✓, step 2 →, Context Bank 含 step 1 结论
5. `prompt()` → 模型执行 step 2

**Turn 5 — Step 2 完成，决策点触发:**

运行时:

1. `completeStep(plan, "step_2", ...)`
2. `checkForDecisionPoint(plan, "step_2")` → 命中
3. `plan.status = 'awaiting_decision'`, `savePlan()`
4. system prompt 包含决策引导
5. Agent 输出用户可见的决策请求
6. 等待用户回复

**用户回复 "1"（Apply all changes）:**

运行时:

1. `plan.status === 'awaiting_decision'` → 处理决策
2. `handleUserDecisionResponse("1", ...)` → proceed
3. `plan.status = 'executing'`, `savePlan()`
4. 继续 step 3

**磁盘 Plan 文件最终状态 (`task_abc123.json`):**

```json
{
  "taskId": "task_abc123",
  "sessionKey": "agent:main:...",
  "taskSummary": "CommonJS to ESM migration",
  "originalQuery": "帮我把这个项目从 CommonJS 迁移到 ESM...",
  "status": "completed",
  "completedSteps": [
    { "stepId": "step_1", "stepNumber": 1, "success": true, "summary": "Found 15 files..." },
    { "stepId": "step_2", "stepNumber": 2, "success": true, "summary": "Converted 47 require..." },
    { "stepId": "step_3", "stepNumber": 3, "success": true, "summary": "Updated package.json..." },
    { "stepId": "step_4", "stepNumber": 4, "success": true, "summary": "All changes verified..." }
  ],
  "currentStepIndex": 4,
  "remainingSteps": [],
  "decisionPoints": [],
  "changeLog": [
    { "type": "step_completed", "timestamp": 1741420800001, "reason": "Found 15 files..." },
    { "type": "step_completed", "timestamp": 1741420800002, "reason": "Converted 47 require..." },
    {
      "type": "decision_resolved",
      "timestamp": 1741420800003,
      "reason": "Selected: Apply all changes"
    },
    { "type": "step_completed", "timestamp": 1741420800004, "reason": "Updated package.json..." },
    { "type": "step_completed", "timestamp": 1741420800005, "reason": "All changes verified..." }
  ]
}
```

**执行过程日志:**

```
[INFO] plan-created taskId=task_abc123 steps=4 decisionPoints=1
[INFO] step-started taskId=task_abc123 stepId=step_1 stepNumber=1
[INFO] step-completed taskId=task_abc123 stepId=step_1 success=true durationMs=2340 summary="Found 15 files with require() statements"
[INFO] step-started taskId=task_abc123 stepId=step_2 stepNumber=2
[INFO] step-completed taskId=task_abc123 stepId=step_2 success=true durationMs=5230 summary="Converted 47 require statements to imports"
[INFO] decision-point-reached taskId=task_abc123 afterStep=step_2 reason="Review converted imports"
[INFO] decision-point-resolved taskId=task_abc123 afterStep=step_2 selectedOption="Apply all changes"
[INFO] step-started taskId=task_abc123 stepId=step_3 stepNumber=3
[INFO] step-completed taskId=task_abc123 stepId=step_3 success=true durationMs=1200 summary="Updated package.json"
[INFO] step-started taskId=task_abc123 stepId=step_4 stepNumber=4
[INFO] step-completed taskId=task_abc123 stepId=step_4 success=true durationMs=3100 summary="All changes verified"
[INFO] orchestration-completed taskId=task_abc123 totalSteps=4 totalDurationMs=14870
[INFO] summary-generated taskId=task_abc123 compressionRatio=16:1
```
