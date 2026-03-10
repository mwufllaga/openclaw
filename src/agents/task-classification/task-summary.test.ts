import { describe, expect, it, vi } from "vitest";

// Mock pi-coding-agent's estimateTokens before importing task-summary module
vi.mock("@mariozechner/pi-coding-agent", () => ({
  estimateTokens: (msg: { content: string }) => Math.ceil(msg.content.length / 4),
}));

// Mock secure-random
vi.mock("../../infra/secure-random.js", () => ({
  generateSecureToken: () => "test1234",
}));

// Mock logger
vi.mock("./logger.js", () => ({
  logSummaryStarted: vi.fn(),
  logSummaryGenerated: vi.fn(),
  logSummaryError: vi.fn(),
}));

import { generateTaskId, generateTaskSummary } from "./task-summary.js";
import { TaskClassificationType, formatTaskSummary, isSummarizedTaskContext } from "./types.js";

describe("generateTaskId", () => {
  it("produces a string starting with 'task-'", () => {
    const id = generateTaskId();
    expect(id).toMatch(/^task-/);
  });

  it("includes a token component", () => {
    const id = generateTaskId();
    expect(id).toContain("test1234");
  });
});

describe("generateTaskSummary", () => {
  it("generates a summary with all required fields", () => {
    const summary = generateTaskSummary({
      taskId: "task-test-001",
      taskType: TaskClassificationType.SIMPLE_TOOL,
      originalQuery: "What's the weather in Tokyo?",
      agentResponse: "The weather in Tokyo is 18°C and partly cloudy.",
      rawContextText: "A".repeat(2000),
    });

    expect(summary.taskId).toBe("task-test-001");
    expect(summary.taskType).toBe(TaskClassificationType.SIMPLE_TOOL);
    expect(summary.originalQuery).toBe("What's the weather in Tokyo?");
    expect(summary.conclusion).toContain("Tokyo");
    expect(summary.isSummarized).toBe(true);
    expect(summary.timestamp).toBeGreaterThan(0);
    expect(summary.originalContextTokens).toBeGreaterThan(0);
    expect(summary.summaryTokens).toBeGreaterThan(0);
  });

  it("compresses long responses into conclusions", () => {
    const longResponse = "Word ".repeat(500);
    const summary = generateTaskSummary({
      taskId: "task-test-002",
      taskType: TaskClassificationType.SIMPLE_TOOL,
      originalQuery: "Generate a report",
      agentResponse: longResponse,
      rawContextText: longResponse.repeat(3),
    });

    // Conclusion should be truncated
    expect(summary.conclusion.length).toBeLessThanOrEqual(1010); // 1000 + "…"
  });

  it("derives process outline from numbered list in response", () => {
    const response = [
      "Here's what I did:",
      "1. Searched for weather data",
      "2. Parsed the JSON response",
      "3. Formatted the results",
      "",
      "The weather is sunny.",
    ].join("\n");

    const summary = generateTaskSummary({
      taskId: "task-test-003",
      taskType: TaskClassificationType.SIMPLE_TOOL,
      originalQuery: "Check weather",
      agentResponse: response,
      rawContextText: response,
    });

    expect(summary.processOutline).toContain("Searched for weather");
    expect(summary.processOutline).toContain("Parsed the JSON");
    expect(summary.processOutline).toContain("Formatted the results");
  });

  it("derives process outline from bullet points", () => {
    const response = ["- Connected to database", "- Queried user table", "- Found 42 records"].join(
      "\n",
    );

    const summary = generateTaskSummary({
      taskId: "task-test-004",
      taskType: TaskClassificationType.SIMPLE_TOOL,
      originalQuery: "Query users",
      agentResponse: response,
      rawContextText: response,
    });

    expect(summary.processOutline).toContain("Connected to database");
    expect(summary.processOutline).toContain("Queried user table");
  });

  it("uses custom process outline when provided", () => {
    const summary = generateTaskSummary({
      taskId: "task-test-005",
      taskType: TaskClassificationType.COMPLEX_ORCHESTRATED,
      originalQuery: "Refactor module",
      agentResponse: "Refactoring complete.",
      rawContextText: "context",
      processOutline: "Step 1: Analyzed deps. Step 2: Moved files. Step 3: Updated imports.",
    });

    expect(summary.processOutline).toBe(
      "Step 1: Analyzed deps. Step 2: Moved files. Step 3: Updated imports.",
    );
  });

  it("formatted summary is recognizable by isSummarizedTaskContext", () => {
    const summary = generateTaskSummary({
      taskId: "task-test-006",
      taskType: TaskClassificationType.SIMPLE_TOOL,
      originalQuery: "Test query",
      agentResponse: "Test response",
      rawContextText: "raw context",
    });

    const formatted = formatTaskSummary(summary);
    expect(isSummarizedTaskContext(formatted)).toBe(true);
  });

  it("summaryTokens is less than originalContextTokens for compressible content", () => {
    const longContext = "A very detailed tool output with lots of data. ".repeat(100);
    const summary = generateTaskSummary({
      taskId: "task-test-007",
      taskType: TaskClassificationType.SIMPLE_TOOL,
      originalQuery: "Process data",
      agentResponse: "Done. 42 records processed.",
      rawContextText: longContext,
    });

    expect(summary.summaryTokens).toBeLessThan(summary.originalContextTokens);
  });
});
