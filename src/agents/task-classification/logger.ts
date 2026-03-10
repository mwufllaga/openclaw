/**
 * Logging infrastructure for the task classification system.
 *
 * Three subsystem loggers:
 * - task-classification: Classification decisions (analysis + conclusion)
 * - task-classification/planning: Execution planning and step tracking
 * - task-classification/summary: Task summary generation
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ClassificationResult, TaskClassificationType, TaskSummary } from "./types.js";

// ─── Classification Logger ───

const classificationLog = createSubsystemLogger("task-classification");

export interface ClassificationLogParams {
  sessionKey?: string;
  sessionId?: string;
  inputSummary: string;
}

export function logClassificationStarted(params: ClassificationLogParams): void {
  classificationLog.debug(
    `classification-started session=${params.sessionKey ?? params.sessionId ?? "unknown"} input="${truncate(params.inputSummary, 200)}"`,
  );
}

export function logAnalysisOutput(params: { sessionKey?: string; analysis: string }): void {
  classificationLog.debug(
    `analysis-output session=${params.sessionKey ?? "unknown"} analysis="${truncate(params.analysis, 500)}"`,
  );
}

export function logClassificationCompleted(params: {
  sessionKey?: string;
  result: ClassificationResult;
  latencyMs: number;
}): void {
  classificationLog.info(
    `classification-completed session=${params.sessionKey ?? "unknown"} ` +
      `type=${params.result.type} latencyMs=${params.latencyMs}`,
    {
      type: params.result.type,
      analysis: params.result.analysis,
      consoleMessage:
        `classification-completed session=${params.sessionKey ?? "unknown"} ` +
        `type=${params.result.type} latencyMs=${params.latencyMs}`,
    },
  );
}

export function logClassificationSkipped(params: { sessionKey?: string; reason: string }): void {
  classificationLog.debug(
    `classification-skipped session=${params.sessionKey ?? "unknown"} reason=${params.reason}`,
  );
}

export function logClassificationError(params: { sessionKey?: string; error: string }): void {
  classificationLog.warn(
    `classification-error session=${params.sessionKey ?? "unknown"} error="${params.error}"`,
  );
}

// ─── Planning Logger ───

const planningLog = createSubsystemLogger("task-classification/planning");

export interface PlanStepInfo {
  stepId: string;
  description: string;
  complexity?: string;
  dependsOn?: string[];
}

export function logPlanCreated(params: {
  taskId: string;
  taskType: TaskClassificationType;
  steps: PlanStepInfo[];
  sessionKey?: string;
}): void {
  planningLog.info(
    `plan-created taskId=${params.taskId} type=${params.taskType} ` +
      `steps=${params.steps.length} session=${params.sessionKey ?? "unknown"}`,
    {
      taskId: params.taskId,
      steps: params.steps.map((s) => ({ id: s.stepId, desc: s.description })),
    },
  );
}

export function logStepStarted(params: {
  taskId: string;
  stepId: string;
  stepNumber: number;
  description: string;
}): void {
  planningLog.info(
    `step-started taskId=${params.taskId} stepId=${params.stepId} ` +
      `step=${params.stepNumber} desc="${truncate(params.description, 100)}"`,
  );
}

export function logStepCompleted(params: {
  taskId: string;
  stepId: string;
  stepNumber: number;
  success: boolean;
  durationMs: number;
  summary: string;
}): void {
  planningLog.info(
    `step-completed taskId=${params.taskId} stepId=${params.stepId} ` +
      `step=${params.stepNumber} success=${params.success} ` +
      `durationMs=${params.durationMs} summary="${truncate(params.summary, 200)}"`,
    {
      taskId: params.taskId,
      stepId: params.stepId,
      success: params.success,
      durationMs: params.durationMs,
      summary: params.summary,
    },
  );
}

export function logExecutionCompleted(params: {
  taskId: string;
  taskType: TaskClassificationType;
  totalSteps: number;
  successfulSteps: number;
  totalDurationMs: number;
}): void {
  planningLog.info(
    `execution-completed taskId=${params.taskId} type=${params.taskType} ` +
      `steps=${params.successfulSteps}/${params.totalSteps} ` +
      `durationMs=${params.totalDurationMs}`,
  );
}

// ─── Summary Logger ───

const summaryLog = createSubsystemLogger("task-classification/summary");

export function logSummaryStarted(params: {
  taskId: string;
  taskType: TaskClassificationType;
  originalTokens: number;
}): void {
  summaryLog.debug(
    `summary-started taskId=${params.taskId} type=${params.taskType} ` +
      `originalTokens=${params.originalTokens}`,
  );
}

export function logSummaryGenerated(params: { taskId: string; summary: TaskSummary }): void {
  const ratio =
    params.summary.summaryTokens > 0
      ? (params.summary.originalContextTokens / params.summary.summaryTokens).toFixed(1)
      : "N/A";

  summaryLog.info(
    `summary-generated taskId=${params.taskId} type=${params.summary.taskType} ` +
      `originalTokens=${params.summary.originalContextTokens} ` +
      `summaryTokens=${params.summary.summaryTokens} ` +
      `compressionRatio=${ratio}`,
    {
      taskId: params.taskId,
      taskType: params.summary.taskType,
      originalTokens: params.summary.originalContextTokens,
      summaryTokens: params.summary.summaryTokens,
      compressionRatio: ratio,
      conclusion: truncate(params.summary.conclusion, 300),
      processOutline: truncate(params.summary.processOutline, 300),
      consoleMessage:
        `summary-generated taskId=${params.taskId} type=${params.summary.taskType} ` +
        `${params.summary.originalContextTokens}→${params.summary.summaryTokens} tokens (${ratio}x)`,
    },
  );
}

export function logSummaryError(params: { taskId: string; error: string }): void {
  summaryLog.warn(`summary-error taskId=${params.taskId} error="${params.error}"`);
}

// ─── Utilities ───

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}
