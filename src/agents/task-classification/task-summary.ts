/**
 * Task Summary Generator
 *
 * After Type 1 (SIMPLE_TOOL) or Type 2 (COMPLEX_ORCHESTRATED) execution,
 * generates a summary that replaces the original execution context in the session.
 *
 * The summary preserves:
 * - Original user query
 * - Final conclusion/answer
 * - Brief process outline
 *
 * The summary discards:
 * - Detailed reasoning/thinking
 * - Raw tool call results
 * - Intermediate step data
 */

import { estimateTokens } from "@mariozechner/pi-coding-agent";
import { generateSecureToken } from "../../infra/secure-random.js";
import { logSummaryError, logSummaryGenerated, logSummaryStarted } from "./logger.js";
import { type TaskClassificationType, type TaskSummary, formatTaskSummary } from "./types.js";

/**
 * Estimate token count for a text string.
 * Uses the same heuristic as the compaction system.
 */
function estimateTextTokens(text: string): number {
  return estimateTokens({ role: "user", content: text } as unknown as Parameters<
    typeof estimateTokens
  >[0]);
}

/**
 * Generate a unique task ID.
 */
export function generateTaskId(): string {
  return `task-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

export interface GenerateTaskSummaryParams {
  /** Unique task identifier. */
  taskId: string;
  /** The classification type. */
  taskType: TaskClassificationType;
  /** The original user query/message. */
  originalQuery: string;
  /** The final response/conclusion from the agent. */
  agentResponse: string;
  /** All raw messages that were part of this execution (for token counting). */
  rawContextText: string;
  /** Optional explicit process outline. If not provided, derived from response. */
  processOutline?: string;
}

/**
 * Generate a task summary from execution results.
 *
 * This function creates a TaskSummary that:
 * 1. Preserves the original query and final conclusion
 * 2. Generates a brief process outline
 * 3. Records token compression metrics
 * 4. Logs the summary generation
 */
export function generateTaskSummary(params: GenerateTaskSummaryParams): TaskSummary {
  const originalTokens = estimateTextTokens(params.rawContextText);

  logSummaryStarted({
    taskId: params.taskId,
    taskType: params.taskType,
    originalTokens,
  });

  try {
    const conclusion = extractConclusion(params.agentResponse);
    const processOutline = params.processOutline ?? deriveProcessOutline(params.agentResponse);

    const summary: TaskSummary = {
      taskId: params.taskId,
      taskType: params.taskType,
      originalQuery: params.originalQuery,
      conclusion,
      processOutline,
      isSummarized: true,
      timestamp: Date.now(),
      originalContextTokens: originalTokens,
      summaryTokens: 0, // Will be computed after formatting
    };

    // Compute summary token count from the formatted output
    const formatted = formatTaskSummary(summary);
    summary.summaryTokens = estimateTextTokens(formatted);

    logSummaryGenerated({ taskId: params.taskId, summary });

    return summary;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logSummaryError({ taskId: params.taskId, error: errorMessage });

    // Return a minimal summary on error
    return {
      taskId: params.taskId,
      taskType: params.taskType,
      originalQuery: params.originalQuery,
      conclusion: params.agentResponse.slice(0, 500),
      processOutline: "Summary generation failed; raw response truncated.",
      isSummarized: true,
      timestamp: Date.now(),
      originalContextTokens: originalTokens,
      summaryTokens: estimateTextTokens(params.agentResponse.slice(0, 500)),
    };
  }
}

/**
 * Extract the conclusion from the agent's response.
 * Takes the substantive parts, trimming any classification tags or noise.
 */
function extractConclusion(response: string): string {
  // Truncate very long responses to a reasonable conclusion length
  const maxLength = 1000;
  const trimmed = response.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  // Try to find a natural break point
  const breakPoints = ["\n\n", "\n", ". ", "。"];
  for (const bp of breakPoints) {
    const idx = trimmed.lastIndexOf(bp, maxLength);
    if (idx > maxLength * 0.5) {
      return `${trimmed.slice(0, idx + bp.length).trim()}…`;
    }
  }

  return `${trimmed.slice(0, maxLength)}…`;
}

/**
 * Derive a process outline from the agent's response.
 * Looks for tool call indicators and step markers.
 */
function deriveProcessOutline(response: string): string {
  const lines = response.split("\n").filter((line) => line.trim().length > 0);

  // Look for patterns that indicate steps/actions taken
  const stepIndicators = lines.filter(
    (line) =>
      /^[-*•]\s/.test(line.trim()) || // bullet points
      /^\d+[.)]\s/.test(line.trim()) || // numbered lists
      /^(Step|步骤)\s*\d+/i.test(line.trim()), // explicit step markers
  );

  if (stepIndicators.length > 0) {
    return stepIndicators
      .slice(0, 10) // max 10 steps in outline
      .map((line) => line.trim())
      .join("\n");
  }

  // Fallback: first few non-empty lines as process indicator
  return lines
    .slice(0, 3)
    .map((line) => line.trim())
    .join("\n");
}
