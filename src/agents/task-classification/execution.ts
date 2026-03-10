/**
 * Task Classification: Execution handler
 *
 * Handles the three classification paths:
 * - Type 1 (SIMPLE_TOOL): Direct tool execution, then summarize
 * - Type 2 (COMPLEX_ORCHESTRATED): Currently same as Type 1 (direct execution, then summarize)
 * - Type 3 (DIRECT_CONVERSATION): No-op (passthrough, no summary)
 *
 * This module processes agent output after classification has been parsed,
 * determines the execution path, and produces summaries for Type 1/2.
 */

import { logExecutionCompleted, logStepCompleted, logStepStarted } from "./logger.js";
import { generateTaskId, generateTaskSummary } from "./task-summary.js";
import {
  type ClassificationResult,
  type TaskSummary,
  TaskClassificationType,
  formatTaskSummary,
} from "./types.js";

/**
 * Execution result from running a classified task.
 */
export interface TaskExecutionResult {
  /** The classification used. */
  classification: ClassificationResult;
  /** Cleaned output (classification tags stripped). */
  cleanedOutput: string;
  /** Generated task summary (null for DIRECT_CONVERSATION). */
  summary: TaskSummary | null;
  /** Formatted summary block for transcript injection (null for DIRECT_CONVERSATION). */
  formattedSummary: string | null;
  /** Unique task ID (always generated). */
  taskId: string;
  /** Whether this task type produces a summary. */
  hasSummary: boolean;
}

/**
 * Process a classified agent output through the appropriate execution path.
 *
 * For Type 1 (SIMPLE_TOOL) and Type 2 (COMPLEX_ORCHESTRATED):
 *   - Records execution step (single step for now)
 *   - Generates a TaskSummary
 *   - Returns formatted summary for transcript replacement
 *
 * For Type 3 (DIRECT_CONVERSATION):
 *   - Passthrough, no summary generated
 *
 * @param params.classification - The parsed classification result
 * @param params.cleanedOutput - Agent output with classification tags stripped
 * @param params.userMessage - The original user message
 * @param params.rawContextText - Full raw context for token counting
 * @param params.sessionKey - Session key for logging
 */
export function processClassifiedOutput(params: {
  classification: ClassificationResult;
  cleanedOutput: string;
  userMessage: string;
  rawContextText: string;
  sessionKey?: string;
}): TaskExecutionResult {
  const taskId = generateTaskId();
  const { classification, cleanedOutput, userMessage, rawContextText } = params;

  // Type 3: Direct conversation — no summary, passthrough
  if (classification.type === TaskClassificationType.DIRECT_CONVERSATION) {
    return {
      classification,
      cleanedOutput,
      summary: null,
      formattedSummary: null,
      taskId,
      hasSummary: false,
    };
  }

  // Type 1 and Type 2: tool execution path (both use direct execution for now)
  const startTime = Date.now();

  logStepStarted({
    taskId,
    stepId: "step_1",
    stepNumber: 1,
    description:
      classification.type === TaskClassificationType.SIMPLE_TOOL
        ? "Direct tool execution"
        : "Complex task execution (direct mode)",
  });

  // The agent has already executed (output is in cleanedOutput).
  // We record the single-step completion.
  const durationMs = Date.now() - startTime;

  logStepCompleted({
    taskId,
    stepId: "step_1",
    stepNumber: 1,
    success: true,
    durationMs,
    summary: cleanedOutput.slice(0, 200),
  });

  logExecutionCompleted({
    taskId,
    taskType: classification.type,
    totalSteps: 1,
    successfulSteps: 1,
    totalDurationMs: durationMs,
  });

  // Generate summary
  const summary = generateTaskSummary({
    taskId,
    taskType: classification.type,
    originalQuery: userMessage,
    agentResponse: cleanedOutput,
    rawContextText,
  });

  const formattedSummary = formatTaskSummary(summary);

  return {
    classification,
    cleanedOutput,
    summary,
    formattedSummary,
    taskId,
    hasSummary: true,
  };
}

/**
 * Check if a classification type requires summary generation.
 */
export function requiresSummary(type: TaskClassificationType): boolean {
  return (
    type === TaskClassificationType.SIMPLE_TOOL ||
    type === TaskClassificationType.COMPLEX_ORCHESTRATED
  );
}
