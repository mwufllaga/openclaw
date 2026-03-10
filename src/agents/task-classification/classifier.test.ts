import { describe, expect, it } from "vitest";
import {
  ANALYSIS_CLOSE_TAG,
  ANALYSIS_OPEN_TAG,
  buildClassificationPromptSection,
  CLASSIFICATION_CLOSE_TAG,
  CLASSIFICATION_OPEN_TAG,
  classifyFromAgentOutput,
  CONCLUSION_CLOSE_TAG,
  CONCLUSION_OPEN_TAG,
  parseClassificationFromOutput,
  validateClassification,
} from "./classifier.js";
import { TaskClassificationType } from "./types.js";
import type { ClassificationResult } from "./types.js";

// ─── Helpers ───

function makeClassificationBlock(params: { analysis: string; type: string }): string {
  return [
    CLASSIFICATION_OPEN_TAG,
    ANALYSIS_OPEN_TAG,
    params.analysis,
    ANALYSIS_CLOSE_TAG,
    CONCLUSION_OPEN_TAG,
    `type: ${params.type}`,
    CONCLUSION_CLOSE_TAG,
    CLASSIFICATION_CLOSE_TAG,
  ].join("\n");
}

function makeFullOutput(classificationBlock: string, responseText: string): string {
  return `${classificationBlock}\n\n${responseText}`;
}

// ─── Tests ───

describe("buildClassificationPromptSection", () => {
  it("produces a non-empty prompt section", () => {
    const section = buildClassificationPromptSection({ availableTools: ["web_search", "exec"] });
    expect(section.length).toBeGreaterThan(100);
  });

  it("includes all classification type definitions", () => {
    const section = buildClassificationPromptSection({ availableTools: [] });
    expect(section).toContain("SIMPLE_TOOL");
    expect(section).toContain("COMPLEX_ORCHESTRATED");
    expect(section).toContain("DIRECT_CONVERSATION");
  });

  it("lists available tools", () => {
    const section = buildClassificationPromptSection({
      availableTools: ["web_search", "exec", "read"],
    });
    expect(section).toContain("web_search");
    expect(section).toContain("exec");
    expect(section).toContain("read");
  });

  it("handles empty tool list gracefully", () => {
    const section = buildClassificationPromptSection({ availableTools: [] });
    expect(section).toContain("No tools currently available");
  });

  it("contains analysis-first instruction", () => {
    const section = buildClassificationPromptSection({ availableTools: [] });
    expect(section).toContain("analysis MUST come before conclusion");
  });

  it("includes all required tags", () => {
    const section = buildClassificationPromptSection({ availableTools: [] });
    expect(section).toContain(CLASSIFICATION_OPEN_TAG);
    expect(section).toContain(CLASSIFICATION_CLOSE_TAG);
    expect(section).toContain(ANALYSIS_OPEN_TAG);
    expect(section).toContain(ANALYSIS_CLOSE_TAG);
    expect(section).toContain(CONCLUSION_OPEN_TAG);
    expect(section).toContain(CONCLUSION_CLOSE_TAG);
  });
});

describe("parseClassificationFromOutput", () => {
  it("successfully parses a valid classification block", () => {
    const block = makeClassificationBlock({
      analysis:
        "The user wants to search for weather information. This requires a web_search tool call. Single step, no dependencies.",
      type: "SIMPLE_TOOL",
    });
    const output = makeFullOutput(block, "The weather today is sunny.");

    const { classification, cleanedOutput } = parseClassificationFromOutput(output);

    expect(classification).not.toBeNull();
    expect(classification!.type).toBe(TaskClassificationType.SIMPLE_TOOL);
    expect(classification!.analysis).toContain("web_search");
    expect(cleanedOutput).toBe("The weather today is sunny.");
  });

  it("parses COMPLEX_ORCHESTRATED type", () => {
    const block = makeClassificationBlock({
      analysis:
        "This task requires multiple steps: scanning the codebase, analyzing patterns, then refactoring. Steps depend on each other and re-planning may be needed.",
      type: "COMPLEX_ORCHESTRATED",
    });
    const output = makeFullOutput(block, "I'll start by scanning the codebase.");

    const { classification } = parseClassificationFromOutput(output);

    expect(classification!.type).toBe(TaskClassificationType.COMPLEX_ORCHESTRATED);
  });

  it("parses DIRECT_CONVERSATION type", () => {
    const block = makeClassificationBlock({
      analysis:
        "This is a greeting message. No tools are needed. A simple direct response is appropriate.",
      type: "DIRECT_CONVERSATION",
    });
    const output = makeFullOutput(block, "Hello! How can I help you today?");

    const { classification, cleanedOutput } = parseClassificationFromOutput(output);

    expect(classification!.type).toBe(TaskClassificationType.DIRECT_CONVERSATION);
    expect(cleanedOutput).toBe("Hello! How can I help you today?");
  });

  it("returns null classification when no tags present", () => {
    const { classification, cleanedOutput } = parseClassificationFromOutput(
      "Just a plain response with no classification.",
    );

    expect(classification).toBeNull();
    expect(cleanedOutput).toBe("Just a plain response with no classification.");
  });

  it("returns null when analysis tag is missing", () => {
    const output = [
      CLASSIFICATION_OPEN_TAG,
      CONCLUSION_OPEN_TAG,
      "type: SIMPLE_TOOL",
      CONCLUSION_CLOSE_TAG,
      CLASSIFICATION_CLOSE_TAG,
    ].join("\n");

    const { classification } = parseClassificationFromOutput(output);
    expect(classification).toBeNull();
  });

  it("returns null when conclusion tag is missing", () => {
    const output = [
      CLASSIFICATION_OPEN_TAG,
      ANALYSIS_OPEN_TAG,
      "Some analysis here about the task.",
      ANALYSIS_CLOSE_TAG,
      CLASSIFICATION_CLOSE_TAG,
    ].join("\n");

    const { classification } = parseClassificationFromOutput(output);
    expect(classification).toBeNull();
  });

  it("returns null when type is not recognized", () => {
    const block = makeClassificationBlock({
      analysis: "Some analysis that discusses the task at length.",
      type: "INVALID_TYPE",
    });
    const { classification } = parseClassificationFromOutput(block);
    expect(classification).toBeNull();
  });

  it("strips classification block from output text", () => {
    const block = makeClassificationBlock({
      analysis: "Analysis of the task requiring tool usage.",
      type: "SIMPLE_TOOL",
    });
    const responseText = "Here is my response to the user.";
    const output = `Some prefix ${block} ${responseText}`;

    const { cleanedOutput } = parseClassificationFromOutput(output);
    expect(cleanedOutput).not.toContain(CLASSIFICATION_OPEN_TAG);
    expect(cleanedOutput).not.toContain(CLASSIFICATION_CLOSE_TAG);
    expect(cleanedOutput).toContain("Here is my response");
  });

  it("parses conclusion with only type field", () => {
    const output = [
      CLASSIFICATION_OPEN_TAG,
      ANALYSIS_OPEN_TAG,
      "This task needs analysis and multiple considerations.",
      ANALYSIS_CLOSE_TAG,
      CONCLUSION_OPEN_TAG,
      "type: DIRECT_CONVERSATION",
      CONCLUSION_CLOSE_TAG,
      CLASSIFICATION_CLOSE_TAG,
    ].join("\n");

    const { classification } = parseClassificationFromOutput(output);
    expect(classification!.type).toBe(TaskClassificationType.DIRECT_CONVERSATION);
  });

  it("parses type with surrounding whitespace", () => {
    const block = makeClassificationBlock({
      analysis: "Detailed analysis of the task and its requirements.",
      type: "SIMPLE_TOOL",
    });
    const { classification } = parseClassificationFromOutput(block);
    expect(classification!.type).toBe(TaskClassificationType.SIMPLE_TOOL);
  });
});

describe("validateClassification", () => {
  function makeValidResult(overrides?: Partial<ClassificationResult>): ClassificationResult {
    return {
      analysis:
        "This is a sufficiently long analysis of the incoming task that meets the minimum length.",
      type: TaskClassificationType.SIMPLE_TOOL,
      analysisTimestamp: 1000,
      conclusionTimestamp: 1001,
      ...overrides,
    };
  }

  it("returns null for a valid result", () => {
    const result = makeValidResult();
    expect(validateClassification(result)).toBeNull();
  });

  it("rejects empty analysis", () => {
    const result = makeValidResult({ analysis: "" });
    const error = validateClassification(result);
    expect(error).toContain("Analysis too short");
  });

  it("rejects very short analysis", () => {
    const result = makeValidResult({ analysis: "Too short" });
    const error = validateClassification(result);
    expect(error).toContain("Analysis too short");
  });

  it("rejects invalid classification type", () => {
    const result = makeValidResult({ type: "INVALID" as TaskClassificationType });
    const error = validateClassification(result);
    expect(error).toContain("Invalid classification type");
  });

  it("rejects when analysis timestamp >= conclusion timestamp", () => {
    const result = makeValidResult({
      analysisTimestamp: 1000,
      conclusionTimestamp: 1000,
    });
    const error = validateClassification(result);
    expect(error).toContain("analysis-first violated");
  });

  it("rejects when analysis timestamp > conclusion timestamp", () => {
    const result = makeValidResult({
      analysisTimestamp: 2000,
      conclusionTimestamp: 1000,
    });
    const error = validateClassification(result);
    expect(error).toContain("analysis-first violated");
  });

  it("accepts all valid classification types", () => {
    for (const type of Object.values(TaskClassificationType)) {
      const result = makeValidResult({ type });
      expect(validateClassification(result)).toBeNull();
    }
  });
});

describe("classifyFromAgentOutput", () => {
  it("returns parsed classification from valid output", () => {
    const block = makeClassificationBlock({
      analysis:
        "The user is asking about weather. This requires a web_search call. Single step, no dependencies or re-planning needed.",
      type: "SIMPLE_TOOL",
    });
    const output = makeFullOutput(block, "The weather is sunny today.");

    const { classification, cleanedOutput } = classifyFromAgentOutput({
      rawOutput: output,
      sessionKey: "test-session",
      userMessage: "What's the weather?",
    });

    expect(classification.type).toBe(TaskClassificationType.SIMPLE_TOOL);
    expect(cleanedOutput).toBe("The weather is sunny today.");
  });

  it("returns default DIRECT_CONVERSATION when parsing fails", () => {
    const { classification, cleanedOutput } = classifyFromAgentOutput({
      rawOutput: "Just a plain response.",
      sessionKey: "test-session",
      userMessage: "Hello",
    });

    expect(classification.type).toBe(TaskClassificationType.DIRECT_CONVERSATION);
    expect(cleanedOutput).toBe("Just a plain response.");
  });

  it("returns default when analysis is too short", () => {
    const block = makeClassificationBlock({
      analysis: "Short",
      type: "SIMPLE_TOOL",
    });
    const output = makeFullOutput(block, "Response");

    const { classification, cleanedOutput } = classifyFromAgentOutput({
      rawOutput: output,
      sessionKey: "test-session",
      userMessage: "Test",
    });

    // Should fall back to default because analysis is too short
    expect(classification.type).toBe(TaskClassificationType.DIRECT_CONVERSATION);
    // cleanedOutput should be original since validation failed
    expect(cleanedOutput).toBe(output);
  });

  it("handles missing sessionKey gracefully", () => {
    const block = makeClassificationBlock({
      analysis: "Analysis of this request shows it needs no tools at all, just a direct answer.",
      type: "DIRECT_CONVERSATION",
    });
    const output = makeFullOutput(block, "42");

    // Should not throw
    const { classification } = classifyFromAgentOutput({
      rawOutput: output,
      userMessage: "What is 6*7?",
    });

    expect(classification.type).toBe(TaskClassificationType.DIRECT_CONVERSATION);
  });
});
