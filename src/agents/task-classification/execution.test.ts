/**
 * Task Classification: Execution handler unit tests
 */

import { describe, expect, it, vi } from "vitest";
import { processClassifiedOutput, requiresSummary } from "./execution.js";
import { type ClassificationResult, TaskClassificationType } from "./types.js";

// Mock logger to avoid real logging side effects
vi.mock("./logger.js", () => ({
  logStepStarted: vi.fn(),
  logStepCompleted: vi.fn(),
  logExecutionCompleted: vi.fn(),
  logSummaryStarted: vi.fn(),
  logSummaryGenerated: vi.fn(),
  logSummaryError: vi.fn(),
}));

function makeClassification(
  type: TaskClassificationType,
  overrides?: Partial<ClassificationResult>,
): ClassificationResult {
  const now = Date.now();
  return {
    analysis: "Test analysis that is long enough to pass validation checks.",
    type,
    analysisTimestamp: now,
    conclusionTimestamp: now + 1,
    ...overrides,
  };
}

describe("processClassifiedOutput", () => {
  it("Type 3 (DIRECT_CONVERSATION) returns no summary", () => {
    const result = processClassifiedOutput({
      classification: makeClassification(TaskClassificationType.DIRECT_CONVERSATION),
      cleanedOutput: "Hello! How can I help?",
      userMessage: "Hi",
      rawContextText: "Hi\nHello! How can I help?",
    });

    expect(result.hasSummary).toBe(false);
    expect(result.summary).toBeNull();
    expect(result.formattedSummary).toBeNull();
    expect(result.cleanedOutput).toBe("Hello! How can I help?");
    expect(result.taskId).toMatch(/^task-/);
  });

  it("Type 1 (SIMPLE_TOOL) generates summary", () => {
    const result = processClassifiedOutput({
      classification: makeClassification(TaskClassificationType.SIMPLE_TOOL),
      cleanedOutput: "The weather in Beijing is 25°C and sunny.",
      userMessage: "今天北京天气如何？",
      rawContextText:
        "User: 今天北京天气如何？\nTool: web_search result...\nAssistant: The weather in Beijing is 25°C and sunny.",
    });

    expect(result.hasSummary).toBe(true);
    expect(result.summary).not.toBeNull();
    expect(result.summary!.taskType).toBe(TaskClassificationType.SIMPLE_TOOL);
    expect(result.summary!.originalQuery).toBe("今天北京天气如何？");
    expect(result.summary!.isSummarized).toBe(true);
    expect(result.formattedSummary).toContain("[SUMMARIZED_TASK_CONTEXT]");
    expect(result.formattedSummary).toContain("[/SUMMARIZED_TASK_CONTEXT]");
  });

  it("Type 2 (COMPLEX_ORCHESTRATED) generates summary (direct mode)", () => {
    const result = processClassifiedOutput({
      classification: makeClassification(TaskClassificationType.COMPLEX_ORCHESTRATED),
      cleanedOutput: "Migration completed. 15 files updated.",
      userMessage: "迁移到 ESM",
      rawContextText: "A very long context with lots of tool results...",
    });

    expect(result.hasSummary).toBe(true);
    expect(result.summary).not.toBeNull();
    expect(result.summary!.taskType).toBe(TaskClassificationType.COMPLEX_ORCHESTRATED);
    expect(result.summary!.originalQuery).toBe("迁移到 ESM");
    expect(result.formattedSummary).toContain("COMPLEX_ORCHESTRATED");
  });

  it("summary contains compression metrics", () => {
    const longContext = "Tool result data. ".repeat(500);
    const result = processClassifiedOutput({
      classification: makeClassification(TaskClassificationType.SIMPLE_TOOL),
      cleanedOutput: "Done.",
      userMessage: "Run the query",
      rawContextText: longContext,
    });

    expect(result.summary!.originalContextTokens).toBeGreaterThan(0);
    expect(result.summary!.summaryTokens).toBeGreaterThan(0);
    expect(result.summary!.originalContextTokens).toBeGreaterThan(result.summary!.summaryTokens);
  });

  it("taskId is unique across calls", () => {
    const r1 = processClassifiedOutput({
      classification: makeClassification(TaskClassificationType.DIRECT_CONVERSATION),
      cleanedOutput: "a",
      userMessage: "a",
      rawContextText: "a",
    });
    const r2 = processClassifiedOutput({
      classification: makeClassification(TaskClassificationType.DIRECT_CONVERSATION),
      cleanedOutput: "b",
      userMessage: "b",
      rawContextText: "b",
    });

    expect(r1.taskId).not.toBe(r2.taskId);
  });
});

describe("requiresSummary", () => {
  it("returns true for SIMPLE_TOOL", () => {
    expect(requiresSummary(TaskClassificationType.SIMPLE_TOOL)).toBe(true);
  });

  it("returns true for COMPLEX_ORCHESTRATED", () => {
    expect(requiresSummary(TaskClassificationType.COMPLEX_ORCHESTRATED)).toBe(true);
  });

  it("returns false for DIRECT_CONVERSATION", () => {
    expect(requiresSummary(TaskClassificationType.DIRECT_CONVERSATION)).toBe(false);
  });
});
