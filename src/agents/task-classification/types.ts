/**
 * Task Classification Type Definitions
 *
 * Three-way classification for incoming user messages:
 * - SIMPLE_TOOL: Single-step tool tasks, status queries, knowledge lookups
 * - COMPLEX_ORCHESTRATED: Multi-step tasks with dependencies and re-planning risk
 * - DIRECT_CONVERSATION: No tools needed, casual chat or direct answers
 */

/**
 * The three task classification types.
 *
 * Type 1 (SIMPLE_TOOL): Needs external tools but no re-planning risk.
 *   Single-step, status queries, knowledge lookups, or tasks where failure
 *   still produces a conclusive result.
 *
 * Type 2 (COMPLEX_ORCHESTRATED): Needs external tools with re-planning risk.
 *   Multi-step with inter-step dependencies, partial failure handling,
 *   or steps that cannot proceed without prior step conclusions.
 *   NOTE: Currently executes the same as Type 1 (direct execution).
 *   Orchestrated execution via subagent planning is planned for a future iteration.
 *
 * Type 3 (DIRECT_CONVERSATION): No external tools needed.
 *   Daily chat, answerable questions, or user inquiries.
 */
export const TaskClassificationType = {
  SIMPLE_TOOL: "SIMPLE_TOOL",
  COMPLEX_ORCHESTRATED: "COMPLEX_ORCHESTRATED",
  DIRECT_CONVERSATION: "DIRECT_CONVERSATION",
} as const;

export type TaskClassificationType =
  (typeof TaskClassificationType)[keyof typeof TaskClassificationType];

/**
 * Result of the classification analysis.
 * The classifier is required to produce `analysis` BEFORE `type` (analysis-first mode)
 * to prevent reverse-reasoning by the LLM.
 */
export interface ClassificationResult {
  /** The analysis reasoning produced BEFORE the classification decision. */
  analysis: string;
  /** The classification type concluded AFTER the analysis. */
  type: TaskClassificationType;
  /** Timestamp when analysis was completed (must be < conclusionTimestamp). */
  analysisTimestamp: number;
  /** Timestamp when classification conclusion was reached. */
  conclusionTimestamp: number;
}

/**
 * Task summary produced after Type 1 / Type 2 execution.
 * Replaces the full execution context in the session transcript.
 */
export interface TaskSummary {
  /** Unique task identifier. */
  taskId: string;
  /** The classification type used. */
  taskType: TaskClassificationType;
  /** Original user query. */
  originalQuery: string;
  /** Final conclusion / answer. */
  conclusion: string;
  /** Brief outline of the execution process. */
  processOutline: string;
  /** Whether this content is a summary (always true, for model awareness). */
  isSummarized: true;
  /** Timestamp of summary generation. */
  timestamp: number;
  /** Token count of original context before summarization. */
  originalContextTokens: number;
  /** Token count of the summary. */
  summaryTokens: number;
}

/** Marker tags for summarized task context in the transcript. */
export const SUMMARIZED_TASK_OPEN_TAG = "[SUMMARIZED_TASK_CONTEXT]";
export const SUMMARIZED_TASK_CLOSE_TAG = "[/SUMMARIZED_TASK_CONTEXT]";

/**
 * Format a TaskSummary into the standard transcript marker format.
 * The model is trained to recognize this as summarized (not raw) content.
 */
export function formatTaskSummary(summary: TaskSummary): string {
  return [
    SUMMARIZED_TASK_OPEN_TAG,
    `Task ID: ${summary.taskId}`,
    `Classification: ${summary.taskType}`,
    `Original Query: ${summary.originalQuery}`,
    `Conclusion: ${summary.conclusion}`,
    `Process: ${summary.processOutline}`,
    `Summarized: true (this content replaces the original execution context)`,
    `Timestamp: ${new Date(summary.timestamp).toISOString()}`,
    `Compression: ${summary.originalContextTokens} → ${summary.summaryTokens} tokens`,
    SUMMARIZED_TASK_CLOSE_TAG,
  ].join("\n");
}

/**
 * Check whether a message content string contains a summarized task context block.
 */
export function isSummarizedTaskContext(content: string): boolean {
  return content.includes(SUMMARIZED_TASK_OPEN_TAG) && content.includes(SUMMARIZED_TASK_CLOSE_TAG);
}
