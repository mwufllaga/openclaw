/**
 * Task Classification: Live E2E tests with real LLM model calls.
 *
 * These tests call actual LLM APIs to verify that the classification system
 * works end-to-end: system prompt injection → model generates classification
 * block → parser extracts valid classification → tags stripped from output.
 *
 * Gated by environment variables:
 *   LIVE=1                    Enable live tests (any provider with a key)
 *   KIMI_API_KEY=sk-...       Kimi API key (preferred)
 *   ANTHROPIC_API_KEY=sk-...  Anthropic API key
 *   OPENAI_API_KEY=sk-...     OpenAI API key
 *
 * Run: npx vitest run --config vitest.live.config.ts src/agents/task-classification/classification.live.test.ts
 */

import { completeSimple, getModel, type Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../../infra/env.js";
import {
  buildClassificationPromptSection,
  parseClassificationFromOutput,
  classifyFromAgentOutput,
  validateClassification,
} from "./classifier.js";
import {
  wrapStreamFnWithClassification,
  CLASSIFICATION_INJECT_START,
  CLASSIFICATION_INJECT_END,
} from "./stream-injection.js";
import { TaskClassificationType } from "./types.js";

// ─── Environment gating ─────────────────────────────────────────────

const LIVE = isTruthyEnvValue(process.env.LIVE);
const KIMI_KEY = process.env.KIMI_API_KEY ?? "";
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";

type ProviderSetup = {
  kind: "known" | "custom";
  apiKey: string;
  /** Only for kind=known */
  provider?: string;
  modelId?: string;
  /** Only for kind=custom */
  model?: Model<"anthropic-messages">;
  headers?: Record<string, string>;
};

function resolveProvider(): ProviderSetup | null {
  // Kimi K2.5: custom model object (not a built-in KnownProvider), uses anthropic-messages API
  if (KIMI_KEY) {
    const model: Model<"anthropic-messages"> = {
      id: "kimi-k2-5",
      name: "Kimi K2.5",
      api: "anthropic-messages",
      provider: "kimi",
      baseUrl: "https://api.kimi.com/coding",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32768,
    };
    return {
      kind: "custom",
      apiKey: KIMI_KEY,
      model,
      headers: { "User-Agent": "Kimi Claw Plugin" },
    };
  }
  if (ANTHROPIC_KEY) {
    return {
      kind: "known",
      apiKey: ANTHROPIC_KEY,
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    };
  }
  if (OPENAI_KEY) {
    return { kind: "known", apiKey: OPENAI_KEY, provider: "openai", modelId: "gpt-4.1-mini" };
  }
  return null;
}

const providerSetup = resolveProvider();
const describeLive = LIVE && providerSetup ? describe : describe.skip;

// ─── Helpers ─────────────────────────────────────────────────────────

const CLASSIFICATION_SYSTEM_PROMPT = [
  "You are a helpful assistant.",
  "",
  buildClassificationPromptSection({ availableTools: ["web_search", "calculator", "file_read"] }),
  "",
  "After the classification block, respond normally to the user.",
].join("\n");

const CLASSIFICATION_SYSTEM_PROMPT_NO_TOOLS = [
  "You are a helpful assistant.",
  "",
  buildClassificationPromptSection({ availableTools: [] }),
  "",
  "After the classification block, respond normally to the user.",
].join("\n");

async function callModel(params: {
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
}): Promise<string> {
  if (!providerSetup) {
    throw new Error("No provider configured");
  }

  // Resolve the model object: custom (Kimi) or built-in (Anthropic/OpenAI)
  /* oxlint-disable typescript/no-explicit-any -- loose types in test helper */
  const model: Model<any> =
    providerSetup.kind === "custom"
      ? providerSetup.model!
      : getModel(providerSetup.provider as any, providerSetup.modelId as any);
  /* oxlint-enable typescript/no-explicit-any */

  const providerLabel = providerSetup.kind === "custom" ? model.provider : providerSetup.provider;
  console.log(`[live] Using provider: ${providerLabel}, model: ${model.id}`);

  const res = await completeSimple(
    model,
    {
      systemPrompt: params.systemPrompt,
      messages: [
        {
          role: "user",
          content: params.userMessage,
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: providerSetup.apiKey,
      maxTokens: params.maxTokens ?? 1024,
      ...(providerSetup.headers ? { headers: providerSetup.headers } : {}),
    },
  );

  return res.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// ─── Tests ───────────────────────────────────────────────────────────

describeLive("task classification live (real LLM)", () => {
  describe("Type 1: SIMPLE_TOOL classification", () => {
    it("classifies a simple tool query correctly", async () => {
      const rawOutput = await callModel({
        systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
        userMessage: "What's the weather in Tokyo right now?",
      });

      console.log("[live] Raw model output (SIMPLE_TOOL):", rawOutput.slice(0, 500));

      const { classification, cleanedOutput } = parseClassificationFromOutput(rawOutput);

      // Classification block must be present and parseable
      expect(classification).not.toBeNull();
      expect(classification!.type).toBe(TaskClassificationType.SIMPLE_TOOL);
      expect(classification!.analysis.length).toBeGreaterThanOrEqual(20);

      // Validation should pass
      const validationError = validateClassification(classification!);
      expect(validationError).toBeNull();

      // Cleaned output should NOT contain classification tags
      expect(cleanedOutput).not.toContain("<task_classification>");
      expect(cleanedOutput).not.toContain("</task_classification>");
      expect(cleanedOutput).not.toContain("<analysis>");
      expect(cleanedOutput).not.toContain("</analysis>");

      // Cleaned output should have meaningful content
      expect(cleanedOutput.trim().length).toBeGreaterThan(0);
    }, 30_000);
  });

  describe("Type 2: COMPLEX_ORCHESTRATED classification", () => {
    it("classifies a complex multi-step task correctly", async () => {
      const rawOutput = await callModel({
        systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
        userMessage:
          "Search the web for the latest research papers on quantum computing from this month, then create a summary document comparing the top 3 findings, and save it to a file.",
      });

      console.log("[live] Raw model output (COMPLEX):", rawOutput.slice(0, 500));

      const { classification, cleanedOutput } = parseClassificationFromOutput(rawOutput);

      expect(classification).not.toBeNull();
      // Accept COMPLEX_ORCHESTRATED or SIMPLE_TOOL — the model may judge differently,
      // but it should NOT be DIRECT_CONVERSATION since tools are clearly needed.
      expect(classification!.type).not.toBe(TaskClassificationType.DIRECT_CONVERSATION);
      expect(classification!.analysis.length).toBeGreaterThanOrEqual(20);

      const validationError = validateClassification(classification!);
      expect(validationError).toBeNull();

      expect(cleanedOutput).not.toContain("<task_classification>");
    }, 30_000);
  });

  describe("Type 3: DIRECT_CONVERSATION classification", () => {
    it("classifies a casual chat message correctly", async () => {
      const rawOutput = await callModel({
        systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
        userMessage: "Hi there! What does the word 'serendipity' mean?",
      });

      console.log("[live] Raw model output (DIRECT_CONVERSATION):", rawOutput.slice(0, 500));

      const { classification, cleanedOutput } = parseClassificationFromOutput(rawOutput);

      expect(classification).not.toBeNull();
      expect(classification!.type).toBe(TaskClassificationType.DIRECT_CONVERSATION);
      expect(classification!.analysis.length).toBeGreaterThanOrEqual(20);

      const validationError = validateClassification(classification!);
      expect(validationError).toBeNull();

      // Should have a meaningful answer about serendipity
      expect(cleanedOutput.trim().length).toBeGreaterThan(10);
      expect(cleanedOutput).not.toContain("<task_classification>");
    }, 30_000);

    it("classifies with no tools available", async () => {
      const rawOutput = await callModel({
        systemPrompt: CLASSIFICATION_SYSTEM_PROMPT_NO_TOOLS,
        userMessage: "Tell me a joke about programming.",
      });

      console.log("[live] Raw model output (no tools):", rawOutput.slice(0, 500));

      const { classification } = parseClassificationFromOutput(rawOutput);

      expect(classification).not.toBeNull();
      // With no tools available, it should be DIRECT_CONVERSATION
      expect(classification!.type).toBe(TaskClassificationType.DIRECT_CONVERSATION);

      const validationError = validateClassification(classification!);
      expect(validationError).toBeNull();
    }, 30_000);
  });

  describe("full pipeline: classifyFromAgentOutput", () => {
    it("end-to-end: classifyFromAgentOutput parses and validates real model output", async () => {
      const rawOutput = await callModel({
        systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
        userMessage: "Can you search the web for the current Bitcoin price?",
      });

      console.log("[live] Raw model output (pipeline):", rawOutput.slice(0, 500));

      const { classification, cleanedOutput } = classifyFromAgentOutput({
        rawOutput,
        userMessage: "Can you search the web for the current Bitcoin price?",
        sessionKey: "live-test",
        sessionId: "live-session-1",
      });

      // With a real model, classification should succeed and not fall back to default
      expect(classification.type).not.toBe(TaskClassificationType.DIRECT_CONVERSATION);
      expect(classification.analysis.length).toBeGreaterThanOrEqual(20);

      // Cleaned output must not leak classification tags
      expect(cleanedOutput).not.toContain("<task_classification>");
      expect(cleanedOutput).not.toContain("<analysis>");
      expect(cleanedOutput).not.toContain("<conclusion>");
      expect(cleanedOutput.trim().length).toBeGreaterThan(0);
    }, 30_000);
  });

  describe("analysis-first enforcement", () => {
    it("model produces analysis before conclusion (timestamp ordering)", async () => {
      const rawOutput = await callModel({
        systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
        userMessage: "Use the calculator to compute 15 * 37 + 42.",
      });

      console.log("[live] Raw model output (analysis-first):", rawOutput.slice(0, 500));

      const { classification } = parseClassificationFromOutput(rawOutput);

      expect(classification).not.toBeNull();
      // Timestamp ordering is enforced in parseConclusionBlock:
      // conclusionTimestamp = Math.max(Date.now(), analysisTimestamp + 1)
      expect(classification!.conclusionTimestamp).toBeGreaterThan(
        classification!.analysisTimestamp,
      );

      // Analysis text position should come before conclusion in the raw output
      const analysisIdx = rawOutput.indexOf("<analysis>");
      const conclusionIdx = rawOutput.indexOf("<conclusion>");
      expect(analysisIdx).toBeLessThan(conclusionIdx);
    }, 30_000);
  });

  describe("edge cases with real model", () => {
    it("handles ambiguous messages (could be tool or conversation)", async () => {
      // "What time is it?" could be answered directly or via a tool
      const rawOutput = await callModel({
        systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
        userMessage: "What time is it?",
      });

      console.log("[live] Raw model output (ambiguous):", rawOutput.slice(0, 500));

      const { classification } = parseClassificationFromOutput(rawOutput);

      // Should parse successfully regardless of which type it picks
      expect(classification).not.toBeNull();
      expect(Object.values(TaskClassificationType).includes(classification!.type)).toBe(true);
      expect(classification!.analysis.length).toBeGreaterThanOrEqual(20);

      const validationError = validateClassification(classification!);
      expect(validationError).toBeNull();
    }, 30_000);

    it("handles multilingual input (Chinese)", async () => {
      const rawOutput = await callModel({
        systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
        userMessage: "帮我在网上搜索一下北京今天的天气预报",
      });

      console.log("[live] Raw model output (Chinese):", rawOutput.slice(0, 500));

      const { classification, cleanedOutput } = parseClassificationFromOutput(rawOutput);

      expect(classification).not.toBeNull();
      // This clearly requires a web search tool
      expect(classification!.type).not.toBe(TaskClassificationType.DIRECT_CONVERSATION);

      const validationError = validateClassification(classification!);
      expect(validationError).toBeNull();

      expect(cleanedOutput).not.toContain("<task_classification>");
    }, 30_000);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Multi-turn chain: verifies injection + stripping across a full flow
  //
  //   Turn 1  user message       → classification injected, model classifies
  //   Turn 2  tool continuation   → classification stripped, NOT injected
  //   Turn 3  new user message    → fresh classification injected, model classifies
  // ─────────────────────────────────────────────────────────────────────
  describe("multi-turn chain: injection + stripping lifecycle", () => {
    /**
     * A streamFn that:
     * - Always captures the systemPrompt it receives (for assertion)
     * - Calls the real model only when the last message is from a user
     *   (tool continuations skip the API call — we only need to verify prompt cleanup)
     */
    function createSmartStreamFn() {
      const capturedSystemPrompts: string[] = [];
      let callCount = 0;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const streamFn = async (model: any, context: any, options?: any) => {
        const systemPrompt: string = context.systemPrompt ?? "";
        capturedSystemPrompts.push(systemPrompt);

        const messages: Array<{ role?: string }> = context.messages ?? [];
        const lastMsg = messages[messages.length - 1];

        // Only call the model for user turns
        if (lastMsg?.role !== "user") {
          return "[mock tool continuation response]";
        }

        callCount++;
        // Small delay between API calls to avoid rate limiting
        if (callCount > 1) {
          console.log(`[live:smart] Delaying 3s before API call #${callCount}...`);
          await new Promise((r) => setTimeout(r, 3000));
        }

        const res = await completeSimple(model, context, {
          ...options,
          apiKey: providerSetup!.apiKey,
          maxTokens: 1024,
          ...(providerSetup!.headers ? { headers: providerSetup!.headers } : {}),
        });

        const text = res.content
          .filter((block: { type: string }) => block.type === "text")
          .map((block: { text: string }) => block.text)
          .join("");

        if (!text) {
          console.warn(
            `[live:smart] API call #${callCount} returned empty text. Response:`,
            JSON.stringify(res).slice(0, 500),
          );
        }

        return text;
      };

      return { streamFn, capturedSystemPrompts };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function getModel_(): Model<any> {
      if (!providerSetup) {
        throw new Error("No provider");
      }
      return providerSetup.kind === "custom"
        ? providerSetup.model!
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getModel(providerSetup.provider as any, providerSetup.modelId as any);
    }

    const TOOLS = ["web_search", "calculator", "file_read"];
    const BASE_SYSTEM_PROMPT = "You are a helpful assistant. Answer concisely.";

    /** Safely stringify model output (avoids no-base-to-string lint) */
    function asStr(value: unknown): string {
      return typeof value === "string" ? value : JSON.stringify(value);
    }

    it("Turn 1 → user message: classification is injected and model produces valid output", async () => {
      const { streamFn, capturedSystemPrompts } = createSmartStreamFn();
      const wrapped = wrapStreamFnWithClassification(streamFn, TOOLS);
      const model = getModel_();

      const rawOutput = await wrapped(model, {
        systemPrompt: BASE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: "What is 15 * 37?", timestamp: Date.now() }],
      });

      // 1. systemPrompt passed to inner streamFn must contain the classification section
      expect(capturedSystemPrompts).toHaveLength(1);
      const injectedPrompt = capturedSystemPrompts[0];
      expect(injectedPrompt).toContain(CLASSIFICATION_INJECT_START);
      expect(injectedPrompt).toContain(CLASSIFICATION_INJECT_END);
      expect(injectedPrompt).toContain("task_classification");
      // Original base prompt is still there
      expect(injectedPrompt).toContain("You are a helpful assistant");

      // 2. Model output should contain valid classification
      console.log("[live:multi-turn] Turn 1 raw:", asStr(rawOutput).slice(0, 400));
      const { classification } = parseClassificationFromOutput(asStr(rawOutput));
      expect(classification).not.toBeNull();
      expect(classification!.analysis.length).toBeGreaterThanOrEqual(10);
      const err = validateClassification(classification!);
      expect(err).toBeNull();
    }, 30_000);

    it("Turn 2 → tool continuation: classification is stripped, NOT injected", async () => {
      const { streamFn, capturedSystemPrompts } = createSmartStreamFn();
      const wrapped = wrapStreamFnWithClassification(streamFn, TOOLS);

      // Simulate: systemPrompt still has a stale classification block from turn 1
      const stalePrompt = [
        BASE_SYSTEM_PROMPT,
        "",
        CLASSIFICATION_INJECT_START,
        buildClassificationPromptSection({ availableTools: TOOLS }),
        CLASSIFICATION_INJECT_END,
      ].join("\n");

      const model = getModel_();

      // Last message is from assistant (tool continuation), NOT user
      const rawOutput = await wrapped(model, {
        systemPrompt: stalePrompt,
        messages: [
          { role: "user", content: "What is 15 * 37?", timestamp: Date.now() - 5000 },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me calculate that for you using the calculator." },
            ],
            timestamp: Date.now() - 3000,
          },
          {
            role: "toolResult",
            content: JSON.stringify({ result: 555 }),
            timestamp: Date.now(),
          },
        ],
      });

      // 1. systemPrompt passed to inner must NOT contain classification markers
      expect(capturedSystemPrompts).toHaveLength(1);
      const cleanedPrompt = capturedSystemPrompts[0];
      expect(cleanedPrompt).not.toContain(CLASSIFICATION_INJECT_START);
      expect(cleanedPrompt).not.toContain(CLASSIFICATION_INJECT_END);
      // But base prompt is preserved
      expect(cleanedPrompt).toContain("You are a helpful assistant");

      // 2. Model output should NOT contain classification (no instruction to produce one)
      console.log("[live:multi-turn] Turn 2 raw:", asStr(rawOutput).slice(0, 400));
      const { classification } = parseClassificationFromOutput(asStr(rawOutput));
      // Classification may be null because the model was not asked to produce one
      if (classification) {
        // If model still produces something, that's tolerable — but the key
        // assertion is that the systemPrompt did NOT contain classification instructions
        console.log("[live:multi-turn] Turn 2: model produced classification anyway (OK)");
      }
    }, 30_000);

    it("Turn 3 → new user message after tool continuation: fresh classification injected, stale stripped", async () => {
      const { streamFn, capturedSystemPrompts } = createSmartStreamFn();
      const wrapped = wrapStreamFnWithClassification(streamFn, TOOLS);

      // Simulate: systemPrompt has stale classification from turn 1
      const stalePrompt = [
        BASE_SYSTEM_PROMPT,
        "",
        CLASSIFICATION_INJECT_START,
        "OLD STALE CLASSIFICATION CONTENT THAT SHOULD BE REMOVED",
        CLASSIFICATION_INJECT_END,
      ].join("\n");

      const model = getModel_();

      // Last message is user → new user turn
      const rawOutput = await wrapped(model, {
        systemPrompt: stalePrompt,
        messages: [
          { role: "user", content: "What is 15 * 37?", timestamp: Date.now() - 10000 },
          {
            role: "assistant",
            content: [{ type: "text", text: "The result is 555." }],
            timestamp: Date.now() - 5000,
          },
          {
            role: "user",
            content: "Now search the web for the latest news about TypeScript 6.",
            timestamp: Date.now(),
          },
        ],
      });

      // 1. systemPrompt: stale content removed, fresh classification injected
      expect(capturedSystemPrompts).toHaveLength(1);
      const injectedPrompt = capturedSystemPrompts[0];
      expect(injectedPrompt).not.toContain("OLD STALE CLASSIFICATION CONTENT");
      expect(injectedPrompt).toContain(CLASSIFICATION_INJECT_START);
      expect(injectedPrompt).toContain(CLASSIFICATION_INJECT_END);
      // Only ONE pair of sentinels
      const startCount = (
        injectedPrompt.match(
          new RegExp(CLASSIFICATION_INJECT_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
        ) || []
      ).length;
      expect(startCount).toBe(1);
      // Base prompt preserved
      expect(injectedPrompt).toContain("You are a helpful assistant");

      // 2. Model output should have valid classification for the NEW user message
      console.log("[live:multi-turn] Turn 3 raw:", asStr(rawOutput).slice(0, 400));
      const { classification } = parseClassificationFromOutput(asStr(rawOutput));
      expect(classification).not.toBeNull();
      expect(classification!.analysis.length).toBeGreaterThanOrEqual(10);
      const err = validateClassification(classification!);
      expect(err).toBeNull();
    }, 30_000);

    it("full 3-turn chain in one test: inject → strip → re-inject", async () => {
      const { streamFn, capturedSystemPrompts } = createSmartStreamFn();
      const wrapped = wrapStreamFnWithClassification(streamFn, TOOLS);
      const model = getModel_();

      // ── Turn 1: user message ──────────────────────────────
      const turn1Ctx = {
        systemPrompt: BASE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: "Search the web for today's Bitcoin price.",
            timestamp: Date.now(),
          },
        ],
      };
      const turn1Out = await wrapped(model, turn1Ctx);
      console.log("[live:chain] Turn 1:", asStr(turn1Out).slice(0, 300));

      // Verify injection happened
      expect(capturedSystemPrompts[0]).toContain(CLASSIFICATION_INJECT_START);
      const turn1Classification = parseClassificationFromOutput(asStr(turn1Out));
      expect(turn1Classification.classification).not.toBeNull();
      expect(turn1Classification.classification!.type).not.toBe(
        TaskClassificationType.DIRECT_CONVERSATION,
      );

      // ── Turn 2: tool continuation ─────────────────────────
      // The systemPrompt now has the injection from turn 1 (simulating real context accumulation)
      const turn2Ctx = {
        systemPrompt: capturedSystemPrompts[0], // carries stale injection
        messages: [
          {
            role: "user",
            content: "Search the web for today's Bitcoin price.",
            timestamp: Date.now() - 5000,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "I'll search for the current Bitcoin price." }],
            timestamp: Date.now() - 3000,
          },
          {
            role: "toolResult",
            content: JSON.stringify({ price: "$68,500" }),
            timestamp: Date.now(),
          },
        ],
      };
      const turn2Out = await wrapped(model, turn2Ctx);
      console.log("[live:chain] Turn 2:", asStr(turn2Out).slice(0, 300));

      // Verify stale injection was stripped
      expect(capturedSystemPrompts[1]).not.toContain(CLASSIFICATION_INJECT_START);
      expect(capturedSystemPrompts[1]).not.toContain(CLASSIFICATION_INJECT_END);
      expect(capturedSystemPrompts[1]).toContain("You are a helpful assistant");

      // ── Turn 3: new user message ──────────────────────────
      const turn3Ctx = {
        systemPrompt: capturedSystemPrompts[1], // clean prompt from turn 2
        messages: [
          {
            role: "user",
            content: "Search the web for today's Bitcoin price.",
            timestamp: Date.now() - 10000,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "The current Bitcoin price is $68,500." }],
            timestamp: Date.now() - 5000,
          },
          {
            role: "user",
            content: "Thanks! Now tell me a fun fact about cats.",
            timestamp: Date.now(),
          },
        ],
      };
      const turn3Out = await wrapped(model, turn3Ctx);
      console.log("[live:chain] Turn 3:", asStr(turn3Out).slice(0, 300));

      // Fresh classification injected
      expect(capturedSystemPrompts[2]).toContain(CLASSIFICATION_INJECT_START);
      // Exactly one sentinel pair
      const count = (
        capturedSystemPrompts[2].match(
          new RegExp(CLASSIFICATION_INJECT_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
        ) || []
      ).length;
      expect(count).toBe(1);

      // Model produced valid classification for the new user question
      const turn3Classification = parseClassificationFromOutput(asStr(turn3Out));
      expect(turn3Classification.classification).not.toBeNull();
      // "Tell me a fun fact about cats" is a conversational request — no tools needed
      expect(turn3Classification.classification!.type).toBe(
        TaskClassificationType.DIRECT_CONVERSATION,
      );

      const err = validateClassification(turn3Classification.classification!);
      expect(err).toBeNull();

      console.log("[live:chain] All 3 turns completed successfully ✓");
      console.log("[live:chain] Turn 1 type:", turn1Classification.classification!.type);
      console.log("[live:chain] Turn 3 type:", turn3Classification.classification!.type);
    }, 90_000); // 3 model calls — generous timeout
  });
});
