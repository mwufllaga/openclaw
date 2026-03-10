/**
 * Task Classifier
 *
 * Classifies incoming user messages into one of three types:
 * - SIMPLE_TOOL: Single-step tool tasks, no re-planning needed
 * - COMPLEX_ORCHESTRATED: Multi-step tasks (currently uses same path as SIMPLE_TOOL)
 * - DIRECT_CONVERSATION: No tools needed
 *
 * Design: The classifier works via the agent's own reasoning, enforcing
 * analysis-first output to prevent LLM reverse-reasoning (conclusion→justification).
 * Classification is embedded in the system prompt, and the agent's first output
 * is parsed for the classification block.
 */

import {
  logAnalysisOutput,
  logClassificationCompleted,
  logClassificationError,
  logClassificationStarted,
} from "./logger.js";
import { type ClassificationResult, TaskClassificationType } from "./types.js";

/** Minimum length for the analysis text to be considered valid. */
const MIN_ANALYSIS_LENGTH = 10;

/** Tags used by the agent to wrap classification output. */
export const CLASSIFICATION_OPEN_TAG = "<task_classification>";
export const CLASSIFICATION_CLOSE_TAG = "</task_classification>";
export const ANALYSIS_OPEN_TAG = "<analysis>";
export const ANALYSIS_CLOSE_TAG = "</analysis>";
export const CONCLUSION_OPEN_TAG = "<conclusion>";
export const CONCLUSION_CLOSE_TAG = "</conclusion>";

/**
 * Build the classification instruction block to inject into the system prompt.
 *
 * This block instructs the agent to:
 * 1. First produce analysis reasoning (mandatory, must come before conclusion)
 * 2. Then produce a classification conclusion
 * 3. Wrap the whole thing in tags that can be parsed out
 *
 * The output is stripped from the user-visible response.
 */
export function buildClassificationPromptSection(params: { availableTools: string[] }): string {
  const toolList =
    params.availableTools.length > 0
      ? `Available tools: ${params.availableTools.join(", ")}`
      : "No tools currently available.";

  return [
    "## Task Classification (mandatory, internal)",
    "Classify the below user message BEFORE generating your reply.",
    "This classification applies ONLY to the user's new message — do NOT classify tool results or continuation turns.",
    "Wrap your classification in tags — it will be stripped from the user-visible output.",
    "",
    "Classification types:",
    "- SIMPLE_TOOL: Requires external tools but no re-planning risk. The outcome is predictable before execution — single-step tasks, status queries, knowledge lookups, straightforward operations. Even if the tool returns an error, you can directly report the result without needing to adjust strategy.",
    "- COMPLEX_ORCHESTRATED: Requires external tools with re-planning risk. Multi-step tasks where steps have dependencies, where a failure or partial result at one step may require rethinking the approach, or where the next step cannot be determined until the current step completes.",
    "- DIRECT_CONVERSATION: No external tools needed. Casual chat, questions you can answer directly, or responding to the user's inquiry.",
    "",
    toolList,
    "",
    "Output format (analysis MUST come before conclusion, keep analysis to 1-2 sentences):",
    "",
    CLASSIFICATION_OPEN_TAG,
    ANALYSIS_OPEN_TAG,
    "Brief reasoning for your classification.",
    ANALYSIS_CLOSE_TAG,
    CONCLUSION_OPEN_TAG,
    "type: SIMPLE_TOOL | COMPLEX_ORCHESTRATED | DIRECT_CONVERSATION",
    CONCLUSION_CLOSE_TAG,
    CLASSIFICATION_CLOSE_TAG,
    "",
    "Rules:",
    "- CRITICAL: You MUST output the classification block as TEXT first, BEFORE making any tool calls. Do NOT invoke any tools until you have written the full classification block. This is mandatory even when you plan to call tools.",
    "- You MUST output analysis BEFORE the conclusion (prevents reverse-reasoning).",
    "- Keep analysis concise — 1-2 sentences explaining why this type fits.",
    "- After the classification block, proceed with your normal response (including tool calls if needed).",
    "- The classification block is NEVER shown to the user.",
    "",
  ].join("\n");
}

/**
 * Parse a classification result from the agent's output text.
 * Returns the parsed ClassificationResult and the cleaned text (with classification block removed).
 */
export function parseClassificationFromOutput(rawOutput: string): {
  classification: ClassificationResult | null;
  cleanedOutput: string;
} {
  const classificationMatch = extractTagContent(
    rawOutput,
    CLASSIFICATION_OPEN_TAG,
    CLASSIFICATION_CLOSE_TAG,
  );
  if (!classificationMatch) {
    return { classification: null, cleanedOutput: rawOutput };
  }

  const { content: classificationBlock, before, after } = classificationMatch;
  const cleanedOutput = (before + after).trim();

  const analysis = extractSimpleTagContent(
    classificationBlock,
    ANALYSIS_OPEN_TAG,
    ANALYSIS_CLOSE_TAG,
  );
  const conclusion = extractSimpleTagContent(
    classificationBlock,
    CONCLUSION_OPEN_TAG,
    CONCLUSION_CLOSE_TAG,
  );

  if (!analysis || !conclusion) {
    return { classification: null, cleanedOutput: rawOutput };
  }

  const parsed = parseConclusionBlock(analysis, conclusion);
  return { classification: parsed, cleanedOutput };
}

/**
 * Validate that a ClassificationResult meets quality requirements.
 * Returns an error message if invalid, or null if valid.
 */
export function validateClassification(result: ClassificationResult): string | null {
  if (!result.analysis || result.analysis.trim().length < MIN_ANALYSIS_LENGTH) {
    return `Analysis too short (${result.analysis?.length ?? 0} chars, minimum ${MIN_ANALYSIS_LENGTH}). Classification requires substantive analysis.`;
  }

  if (!Object.values(TaskClassificationType).includes(result.type)) {
    return `Invalid classification type: ${result.type}`;
  }

  if (result.analysisTimestamp >= result.conclusionTimestamp) {
    return "Analysis timestamp must precede conclusion timestamp (analysis-first violated).";
  }

  return null;
}

/**
 * Run full classification pipeline:
 * 1. Log start
 * 2. Parse classification from agent output
 * 3. Validate
 * 4. Log result
 * 5. Return result + cleaned output
 *
 * On failure, returns a default classification (DIRECT_CONVERSATION).
 */
export function classifyFromAgentOutput(params: {
  rawOutput: string;
  sessionKey?: string;
  sessionId?: string;
  userMessage: string;
}): {
  classification: ClassificationResult;
  cleanedOutput: string;
} {
  const startTime = Date.now();

  logClassificationStarted({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    inputSummary: params.userMessage,
  });

  const { classification, cleanedOutput } = parseClassificationFromOutput(params.rawOutput);

  if (!classification) {
    logClassificationError({
      sessionKey: params.sessionKey,
      error: "Failed to parse classification block from agent output",
    });
    return {
      classification: createDefaultClassification(),
      cleanedOutput: params.rawOutput,
    };
  }

  logAnalysisOutput({
    sessionKey: params.sessionKey,
    analysis: classification.analysis,
  });

  const validationError = validateClassification(classification);
  if (validationError) {
    logClassificationError({
      sessionKey: params.sessionKey,
      error: validationError,
    });
    return {
      classification: createDefaultClassification(),
      cleanedOutput: params.rawOutput,
    };
  }

  const latencyMs = Date.now() - startTime;
  logClassificationCompleted({
    sessionKey: params.sessionKey,
    result: classification,
    latencyMs,
  });

  return { classification, cleanedOutput };
}

// ─── Internal Helpers ───

function createDefaultClassification(): ClassificationResult {
  const now = Date.now();
  return {
    analysis: "Classification parsing failed; defaulting to DIRECT_CONVERSATION.",
    type: TaskClassificationType.DIRECT_CONVERSATION,
    analysisTimestamp: now,
    conclusionTimestamp: now + 1,
  };
}

function parseConclusionBlock(analysis: string, conclusion: string): ClassificationResult | null {
  const analysisTimestamp = Date.now();

  // Parse type
  const typeMatch = conclusion.match(
    /type:\s*(SIMPLE_TOOL|COMPLEX_ORCHESTRATED|DIRECT_CONVERSATION)/i,
  );
  if (!typeMatch) {
    return null;
  }
  const type = typeMatch[1].toUpperCase() as TaskClassificationType;

  // Ensure conclusion timestamp is strictly after analysis timestamp
  // (Date.now() may be equal on fast machines within the same ms)
  const conclusionTimestamp = Math.max(Date.now(), analysisTimestamp + 1);

  return {
    analysis: analysis.trim(),
    type,
    analysisTimestamp,
    conclusionTimestamp,
  };
}

function extractTagContent(
  text: string,
  openTag: string,
  closeTag: string,
): { content: string; before: string; after: string } | null {
  const openIdx = text.indexOf(openTag);
  if (openIdx === -1) {
    return null;
  }
  const closeIdx = text.indexOf(closeTag, openIdx + openTag.length);
  if (closeIdx === -1) {
    return null;
  }
  const content = text.slice(openIdx + openTag.length, closeIdx).trim();
  const before = text.slice(0, openIdx);
  const after = text.slice(closeIdx + closeTag.length);
  return { content, before, after };
}

function extractSimpleTagContent(text: string, openTag: string, closeTag: string): string | null {
  const result = extractTagContent(text, openTag, closeTag);
  return result?.content ?? null;
}
