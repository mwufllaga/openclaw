/**
 * E2E test harness for task classification.
 *
 * Simulates user messages going through the classification pipeline
 * and validates: classification output, analysis-first ordering,
 * summary generation, and logging completeness.
 */

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
} from "./classifier.js";
import { TaskClassificationType } from "./types.js";

// ─── End-to-End Prompt + Parse Simulation ───

/**
 * Simulate the full round-trip:
 * 1. Build classification prompt section
 * 2. Simulate agent producing a classified output
 * 3. Parse the classification
 * 4. Validate the result
 */
describe("E2E: Classification Pipeline", () => {
  it("Type 1 (SIMPLE_TOOL): weather query round-trip", () => {
    // 1. Build prompt (would be injected into system prompt)
    const promptSection = buildClassificationPromptSection({
      availableTools: ["web_search", "web_fetch"],
    });
    expect(promptSection).toContain("web_search");

    // 2. Simulate agent output with classification block
    const simulatedOutput = [
      CLASSIFICATION_OPEN_TAG,
      ANALYSIS_OPEN_TAG,
      "The user asks about the weather. This requires a web_search call to retrieve current weather data.",
      "Only one step is needed: call web_search with the query.",
      "No dependencies between steps. No re-planning risk.",
      "The result can directly answer the question or confirm that data is unavailable.",
      ANALYSIS_CLOSE_TAG,
      CONCLUSION_OPEN_TAG,
      "type: SIMPLE_TOOL",
      CONCLUSION_CLOSE_TAG,
      CLASSIFICATION_CLOSE_TAG,
      "",
      "Let me check the weather for you.",
    ].join("\n");

    // 3. Parse and validate
    const { classification, cleanedOutput } = classifyFromAgentOutput({
      rawOutput: simulatedOutput,
      sessionKey: "e2e-test-session",
      userMessage: "今天北京天气如何？",
    });

    expect(classification.type).toBe(TaskClassificationType.SIMPLE_TOOL);
    expect(classification.analysis).toContain("web_search");
    expect(classification.analysis.length).toBeGreaterThan(20);
    expect(cleanedOutput).toBe("Let me check the weather for you.");
  });

  it("Type 1 (SIMPLE_TOOL): knowledge lookup round-trip", () => {
    const simulatedOutput = [
      CLASSIFICATION_OPEN_TAG,
      ANALYSIS_OPEN_TAG,
      "The user asks how JavaScript's map function works. This can be answered directly with knowledge,",
      "but a web_search might enhance the answer with recent documentation links.",
      "Single step, no re-planning needed. Even without tools, a direct answer is possible.",
      ANALYSIS_CLOSE_TAG,
      CONCLUSION_OPEN_TAG,
      "type: SIMPLE_TOOL",
      CONCLUSION_CLOSE_TAG,
      CLASSIFICATION_CLOSE_TAG,
      "",
      "The `Array.prototype.map()` method creates a new array...",
    ].join("\n");

    const { classification, cleanedOutput } = classifyFromAgentOutput({
      rawOutput: simulatedOutput,
      sessionKey: "e2e-test-session",
      userMessage: "JavaScript 的 map 函数怎么用？",
    });

    expect(classification.type).toBe(TaskClassificationType.SIMPLE_TOOL);
    expect(cleanedOutput).toContain("Array.prototype.map()");
  });

  it("Type 2 (COMPLEX_ORCHESTRATED): refactoring request round-trip", () => {
    const simulatedOutput = [
      CLASSIFICATION_OPEN_TAG,
      ANALYSIS_OPEN_TAG,
      "The user requests migrating from CommonJS to ESM. This involves multiple steps:",
      "1) Scan codebase for require() patterns",
      "2) Convert each file's imports",
      "3) Update package.json",
      "4) Verify compilation",
      "Each step depends on the previous one. Step 2 cannot proceed without step 1's file list.",
      "Re-planning may be needed if conversion reveals circular dependencies.",
      "User confirmation should be requested before applying changes.",
      ANALYSIS_CLOSE_TAG,
      CONCLUSION_OPEN_TAG,
      "type: COMPLEX_ORCHESTRATED",
      CONCLUSION_CLOSE_TAG,
      CLASSIFICATION_CLOSE_TAG,
      "",
      "I'll start by scanning the codebase for CommonJS patterns.",
    ].join("\n");

    const { classification, cleanedOutput } = classifyFromAgentOutput({
      rawOutput: simulatedOutput,
      sessionKey: "e2e-test-session",
      userMessage: "帮我把项目从 CommonJS 迁移到 ESM",
    });

    expect(classification.type).toBe(TaskClassificationType.COMPLEX_ORCHESTRATED);
    expect(classification.analysis).toContain("require()");
    expect(classification.analysis).toContain("Re-planning");
    expect(cleanedOutput).toContain("scanning the codebase");
  });

  it("Type 3 (DIRECT_CONVERSATION): greeting round-trip", () => {
    const simulatedOutput = [
      CLASSIFICATION_OPEN_TAG,
      ANALYSIS_OPEN_TAG,
      "The user sends a greeting. No tools are required to respond.",
      "This is a simple conversational exchange. No steps, no dependencies.",
      "A direct friendly response is appropriate.",
      ANALYSIS_CLOSE_TAG,
      CONCLUSION_OPEN_TAG,
      "type: DIRECT_CONVERSATION",
      CONCLUSION_CLOSE_TAG,
      CLASSIFICATION_CLOSE_TAG,
      "",
      "你好！有什么我可以帮你的吗？",
    ].join("\n");

    const { classification, cleanedOutput } = classifyFromAgentOutput({
      rawOutput: simulatedOutput,
      sessionKey: "e2e-test-session",
      userMessage: "你好！",
    });

    expect(classification.type).toBe(TaskClassificationType.DIRECT_CONVERSATION);
    expect(cleanedOutput).toBe("你好！有什么我可以帮你的吗？");
  });

  it("Type 3 (DIRECT_CONVERSATION): opinion question round-trip", () => {
    const simulatedOutput = [
      CLASSIFICATION_OPEN_TAG,
      ANALYSIS_OPEN_TAG,
      "The user asks for an opinion about TypeScript. This is a conversational question.",
      "No external tools are needed. I can answer from training knowledge.",
      "No steps, no dependencies, no re-planning risk.",
      ANALYSIS_CLOSE_TAG,
      CONCLUSION_OPEN_TAG,
      "type: DIRECT_CONVERSATION",
      CONCLUSION_CLOSE_TAG,
      CLASSIFICATION_CLOSE_TAG,
      "",
      "TypeScript 确实是一门很实用的语言...",
    ].join("\n");

    const { classification } = classifyFromAgentOutput({
      rawOutput: simulatedOutput,
      sessionKey: "e2e-test-session",
      userMessage: "你觉得 TypeScript 好用吗？",
    });

    expect(classification.type).toBe(TaskClassificationType.DIRECT_CONVERSATION);
  });
});

describe("E2E: Analysis-First Enforcement", () => {
  it("valid output has analysis timestamp before conclusion timestamp", () => {
    const simulatedOutput = [
      CLASSIFICATION_OPEN_TAG,
      ANALYSIS_OPEN_TAG,
      "Analyzing the request: this is a database query task.",
      "It requires connecting to the database and running a query.",
      "Single step, no dependencies.",
      ANALYSIS_CLOSE_TAG,
      CONCLUSION_OPEN_TAG,
      "type: SIMPLE_TOOL",
      CONCLUSION_CLOSE_TAG,
      CLASSIFICATION_CLOSE_TAG,
      "",
      "Running the query now.",
    ].join("\n");

    const { classification } = parseClassificationFromOutput(simulatedOutput);
    expect(classification).not.toBeNull();
    expect(classification!.analysisTimestamp).toBeLessThanOrEqual(
      classification!.conclusionTimestamp,
    );
  });

  it("rejects classification when analysis is missing content", () => {
    const simulatedOutput = [
      CLASSIFICATION_OPEN_TAG,
      ANALYSIS_OPEN_TAG,
      "", // Empty analysis
      ANALYSIS_CLOSE_TAG,
      CONCLUSION_OPEN_TAG,
      "type: SIMPLE_TOOL",
      CONCLUSION_CLOSE_TAG,
      CLASSIFICATION_CLOSE_TAG,
      "",
      "Response",
    ].join("\n");

    const { classification } = classifyFromAgentOutput({
      rawOutput: simulatedOutput,
      sessionKey: "e2e-test",
      userMessage: "test",
    });

    // Should fall back to default because analysis is empty
    expect(classification.type).toBe(TaskClassificationType.DIRECT_CONVERSATION);
  });

  it("analysis contains substantive decision factors", () => {
    const simulatedOutput = [
      CLASSIFICATION_OPEN_TAG,
      ANALYSIS_OPEN_TAG,
      "The user wants to deploy to AWS. This involves multiple tools and steps:",
      "- Need exec to run deployment commands",
      "- Need web_fetch to check deployment status",
      "- Steps have dependencies: build → deploy → verify",
      "- Re-planning may be needed if deployment fails",
      "- User confirmation is recommended before deployment",
      ANALYSIS_CLOSE_TAG,
      CONCLUSION_OPEN_TAG,
      "type: COMPLEX_ORCHESTRATED",
      CONCLUSION_CLOSE_TAG,
      CLASSIFICATION_CLOSE_TAG,
      "",
      "I'll prepare the deployment.",
    ].join("\n");

    const { classification } = classifyFromAgentOutput({
      rawOutput: simulatedOutput,
      sessionKey: "e2e-test",
      userMessage: "帮我部署这个应用到 AWS",
    });

    expect(classification.type).toBe(TaskClassificationType.COMPLEX_ORCHESTRATED);
    // Analysis should contain relevant factors
    expect(classification.analysis).toMatch(/工具|tool|step|依赖|deploy|exec/i);
  });
});

describe("E2E: Classification Block Stripping", () => {
  it("cleanedOutput contains no classification tags", () => {
    const simulatedOutput = [
      CLASSIFICATION_OPEN_TAG,
      ANALYSIS_OPEN_TAG,
      "Analysis of the greeting message - no tools needed.",
      ANALYSIS_CLOSE_TAG,
      CONCLUSION_OPEN_TAG,
      "type: DIRECT_CONVERSATION",
      CONCLUSION_CLOSE_TAG,
      CLASSIFICATION_CLOSE_TAG,
      "",
      "Hello! How can I help?",
    ].join("\n");

    const { cleanedOutput } = classifyFromAgentOutput({
      rawOutput: simulatedOutput,
      sessionKey: "e2e-test",
      userMessage: "Hi",
    });

    expect(cleanedOutput).not.toContain(CLASSIFICATION_OPEN_TAG);
    expect(cleanedOutput).not.toContain(CLASSIFICATION_CLOSE_TAG);
    expect(cleanedOutput).not.toContain(ANALYSIS_OPEN_TAG);
    expect(cleanedOutput).not.toContain(ANALYSIS_CLOSE_TAG);
    expect(cleanedOutput).not.toContain(CONCLUSION_OPEN_TAG);
    expect(cleanedOutput).not.toContain(CONCLUSION_CLOSE_TAG);
    expect(cleanedOutput).toBe("Hello! How can I help?");
  });

  it("preserves text before and after classification block", () => {
    const simulatedOutput = [
      "Thinking about this...",
      CLASSIFICATION_OPEN_TAG,
      ANALYSIS_OPEN_TAG,
      "Quick analysis - this is a simple math question, no tools needed.",
      ANALYSIS_CLOSE_TAG,
      CONCLUSION_OPEN_TAG,
      "type: DIRECT_CONVERSATION",
      CONCLUSION_CLOSE_TAG,
      CLASSIFICATION_CLOSE_TAG,
      "The answer is 42.",
    ].join("\n");

    const { cleanedOutput } = parseClassificationFromOutput(simulatedOutput);
    expect(cleanedOutput).toContain("Thinking about this...");
    expect(cleanedOutput).toContain("The answer is 42.");
  });
});

describe("E2E: Edge Cases", () => {
  it("handles agent output that is completely empty", () => {
    const { classification, cleanedOutput } = classifyFromAgentOutput({
      rawOutput: "",
      sessionKey: "e2e-test",
      userMessage: "Test",
    });

    expect(classification.type).toBe(TaskClassificationType.DIRECT_CONVERSATION);
    expect(cleanedOutput).toBe("");
  });

  it("handles very long analysis gracefully", () => {
    const longAnalysis = "This is a detailed analysis. ".repeat(100);
    const simulatedOutput = [
      CLASSIFICATION_OPEN_TAG,
      ANALYSIS_OPEN_TAG,
      longAnalysis,
      ANALYSIS_CLOSE_TAG,
      CONCLUSION_OPEN_TAG,
      "type: COMPLEX_ORCHESTRATED",
      CONCLUSION_CLOSE_TAG,
      CLASSIFICATION_CLOSE_TAG,
      "",
      "Starting the complex task.",
    ].join("\n");

    const { classification } = classifyFromAgentOutput({
      rawOutput: simulatedOutput,
      sessionKey: "e2e-test",
      userMessage: "Complex task",
    });

    expect(classification.type).toBe(TaskClassificationType.COMPLEX_ORCHESTRATED);
    expect(classification.analysis.length).toBeGreaterThan(100);
  });

  it("handles classification with extra whitespace", () => {
    const simulatedOutput = [
      CLASSIFICATION_OPEN_TAG,
      "",
      ANALYSIS_OPEN_TAG,
      "  Analysis with extra whitespace around it.  ",
      "  Multiple lines of analysis content here.  ",
      ANALYSIS_CLOSE_TAG,
      "",
      CONCLUSION_OPEN_TAG,
      "  type: SIMPLE_TOOL  ",
      CONCLUSION_CLOSE_TAG,
      "",
      CLASSIFICATION_CLOSE_TAG,
      "",
      "Response text.",
    ].join("\n");

    const { classification, cleanedOutput } = classifyFromAgentOutput({
      rawOutput: simulatedOutput,
      sessionKey: "e2e-test",
      userMessage: "Test",
    });

    expect(classification.type).toBe(TaskClassificationType.SIMPLE_TOOL);
    expect(cleanedOutput).toBe("Response text.");
  });
});
