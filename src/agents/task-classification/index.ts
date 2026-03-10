/**
 * Task Classification Module
 *
 * Public API for the task classification system.
 */

export {
  TaskClassificationType,
  type ClassificationResult,
  type TaskSummary,
  SUMMARIZED_TASK_OPEN_TAG,
  SUMMARIZED_TASK_CLOSE_TAG,
  formatTaskSummary,
  isSummarizedTaskContext,
} from "./types.js";

export {
  buildClassificationPromptSection,
  classifyFromAgentOutput,
  parseClassificationFromOutput,
  validateClassification,
  CLASSIFICATION_OPEN_TAG,
  CLASSIFICATION_CLOSE_TAG,
} from "./classifier.js";

export { generateTaskSummary, generateTaskId } from "./task-summary.js";

export { processClassifiedOutput, requiresSummary, type TaskExecutionResult } from "./execution.js";

export {
  wrapStreamFnWithClassification,
  stripClassificationInjection,
  CLASSIFICATION_INJECT_START,
  CLASSIFICATION_INJECT_END,
} from "./stream-injection.js";

export {
  applyTaskClassificationContextReplacement,
  type ContextReplacementResult,
} from "./context-replacement.js";

export {
  logClassificationStarted,
  logClassificationCompleted,
  logClassificationError,
  logClassificationSkipped,
  logAnalysisOutput,
  logPlanCreated,
  logStepStarted,
  logStepCompleted,
  logExecutionCompleted,
  logSummaryStarted,
  logSummaryGenerated,
  logSummaryError,
} from "./logger.js";
