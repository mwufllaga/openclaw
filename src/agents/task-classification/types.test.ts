import { describe, expect, it } from "vitest";
import {
  formatTaskSummary,
  isSummarizedTaskContext,
  SUMMARIZED_TASK_CLOSE_TAG,
  SUMMARIZED_TASK_OPEN_TAG,
  TaskClassificationType,
} from "./types.js";
import type { ClassificationResult, TaskSummary } from "./types.js";

describe("TaskClassificationType", () => {
  it("defines three classification types", () => {
    expect(TaskClassificationType.SIMPLE_TOOL).toBe("SIMPLE_TOOL");
    expect(TaskClassificationType.COMPLEX_ORCHESTRATED).toBe("COMPLEX_ORCHESTRATED");
    expect(TaskClassificationType.DIRECT_CONVERSATION).toBe("DIRECT_CONVERSATION");
  });

  it("all values are distinct", () => {
    const values = Object.values(TaskClassificationType);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("formatTaskSummary", () => {
  const baseSummary: TaskSummary = {
    taskId: "task-abc123",
    taskType: TaskClassificationType.SIMPLE_TOOL,
    originalQuery: "What is the weather today?",
    conclusion: "The weather in Beijing is 15°C, sunny.",
    processOutline: "Called web_search for weather data.",
    isSummarized: true,
    timestamp: 1709827200000,
    originalContextTokens: 500,
    summaryTokens: 80,
  };

  it("includes open and close tags", () => {
    const result = formatTaskSummary(baseSummary);
    expect(result).toContain(SUMMARIZED_TASK_OPEN_TAG);
    expect(result).toContain(SUMMARIZED_TASK_CLOSE_TAG);
  });

  it("includes all key fields", () => {
    const result = formatTaskSummary(baseSummary);
    expect(result).toContain("Task ID: task-abc123");
    expect(result).toContain("Classification: SIMPLE_TOOL");
    expect(result).toContain("Original Query: What is the weather today?");
    expect(result).toContain("Conclusion: The weather in Beijing is 15°C, sunny.");
    expect(result).toContain("Process: Called web_search for weather data.");
    expect(result).toContain("Summarized: true");
    expect(result).toContain("500 → 80 tokens");
  });

  it("open tag appears before close tag", () => {
    const result = formatTaskSummary(baseSummary);
    const openIdx = result.indexOf(SUMMARIZED_TASK_OPEN_TAG);
    const closeIdx = result.indexOf(SUMMARIZED_TASK_CLOSE_TAG);
    expect(openIdx).toBeLessThan(closeIdx);
  });
});

describe("isSummarizedTaskContext", () => {
  it("returns true for text with both tags", () => {
    const text = `${SUMMARIZED_TASK_OPEN_TAG}\nsome content\n${SUMMARIZED_TASK_CLOSE_TAG}`;
    expect(isSummarizedTaskContext(text)).toBe(true);
  });

  it("returns false for text without tags", () => {
    expect(isSummarizedTaskContext("Hello, how are you?")).toBe(false);
  });

  it("returns false for text with only open tag", () => {
    expect(isSummarizedTaskContext(`${SUMMARIZED_TASK_OPEN_TAG} content`)).toBe(false);
  });

  it("returns false for text with only close tag", () => {
    expect(isSummarizedTaskContext(`content ${SUMMARIZED_TASK_CLOSE_TAG}`)).toBe(false);
  });

  it("returns true when tags are embedded in larger text", () => {
    const text = `prefix\n${SUMMARIZED_TASK_OPEN_TAG}\ncontent\n${SUMMARIZED_TASK_CLOSE_TAG}\nsuffix`;
    expect(isSummarizedTaskContext(text)).toBe(true);
  });
});

describe("ClassificationResult interface", () => {
  it("accepts a valid classification result", () => {
    const result: ClassificationResult = {
      analysis: "This task requires a web search to answer the user's question about weather.",
      type: TaskClassificationType.SIMPLE_TOOL,
      analysisTimestamp: 1000,
      conclusionTimestamp: 1001,
    };
    expect(result.type).toBe(TaskClassificationType.SIMPLE_TOOL);
    expect(result.analysisTimestamp).toBeLessThan(result.conclusionTimestamp);
  });
});
