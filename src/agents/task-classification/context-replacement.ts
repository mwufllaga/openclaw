/**
 * Task Classification: Context Replacement
 *
 * After SIMPLE_TOOL or COMPLEX_ORCHESTRATED tasks complete, this module
 * replaces the tool call/result messages in the session context with a
 * compressed summary. The user still sees the full response (UI has already
 * rendered), but the model's context window is freed up.
 *
 * This is analogous to compaction — the user-visible output is unchanged,
 * only the model's view of history is compressed.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseClassificationFromOutput } from "./classifier.js";
import { processClassifiedOutput } from "./execution.js";
import { TaskClassificationType } from "./types.js";

const log = createSubsystemLogger("task-classification");

/**
 * Extract text content from an AgentMessage.
 * Handles both string content and array-of-blocks content.
 */
function extractMessageText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") {
          parts.push(b.text);
        }
      }
    }
    return parts.join("");
  }
  return "";
}

/**
 * Find the index of the last user message in the messages array.
 * This marks the start of the current turn.
 */
function findLastUserMessageIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return i;
    }
  }
  return -1;
}

/**
 * Collect all text from the current turn's assistant messages.
 * The first assistant message typically contains the classification block.
 */
function collectTurnText(messages: AgentMessage[], fromIndex: number): string {
  const parts: string[] = [];
  for (let i = fromIndex; i < messages.length; i++) {
    if (messages[i].role === "assistant") {
      const text = extractMessageText(messages[i]);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

/**
 * Build a raw context string from all messages in the current turn
 * (for token counting in the summary generator).
 */
function collectTurnRawContext(messages: AgentMessage[], fromIndex: number): string {
  const parts: string[] = [];
  for (let i = fromIndex; i < messages.length; i++) {
    const text = extractMessageText(messages[i]);
    if (text) {
      parts.push(`[${messages[i].role}] ${text}`);
    }
  }
  return parts.join("\n\n");
}

export interface ContextReplacementResult {
  /** Whether context was replaced. */
  replaced: boolean;
  /** The classification type detected (null if parsing failed). */
  classificationType: TaskClassificationType | null;
  /** Number of messages replaced. */
  messagesReplaced: number;
  /** The new messages array (if replaced), or the original. */
  messages: AgentMessage[];
}

/**
 * Attempt to replace the current turn's tool-heavy context with a summary.
 *
 * Flow:
 * 1. Find the last user message (start of current turn)
 * 2. Collect all assistant text from the turn
 * 3. Parse classification from the output
 * 4. If SIMPLE_TOOL or COMPLEX_ORCHESTRATED:
 *    - Generate a summary via processClassifiedOutput
 *    - Replace messages from (userIndex+1) to end with a single assistant message
 *      containing the summary AND the final answer
 *    - Keep the user message intact
 * 5. If DIRECT_CONVERSATION or parsing fails, return original messages unchanged
 *
 * @param messages - The current session messages (after prompt completion)
 * @param sessionKey - Session key for logging
 */
export function applyTaskClassificationContextReplacement(
  messages: AgentMessage[],
  sessionKey?: string,
): ContextReplacementResult {
  const userIdx = findLastUserMessageIndex(messages);
  if (userIdx === -1) {
    return { replaced: false, classificationType: null, messagesReplaced: 0, messages };
  }

  // Count messages in this turn (after the user message)
  const turnMessageCount = messages.length - userIdx - 1;
  if (turnMessageCount <= 0) {
    return { replaced: false, classificationType: null, messagesReplaced: 0, messages };
  }

  // Collect all assistant text from the turn to find classification
  const turnAssistantText = collectTurnText(messages, userIdx + 1);
  if (!turnAssistantText) {
    return { replaced: false, classificationType: null, messagesReplaced: 0, messages };
  }

  // Debug: log what we see in the turn messages
  const turnMessages = messages.slice(userIdx + 1);
  log.debug(
    `[context-replacement] turn has ${turnMessages.length} messages: ` +
      turnMessages
        .map((m, i) => `[${i}] role=${m.role} textLen=${extractMessageText(m).length}`)
        .join(", ") +
      ` | assistantTextLen=${turnAssistantText.length}` +
      ` | hasClassificationTag=${turnAssistantText.includes("<task_classification>")}` +
      ` | first200=${turnAssistantText.slice(0, 200).replace(/\n/g, "\\n")}` +
      ` | sessionKey=${sessionKey ?? "unknown"}`,
  );

  // Parse classification from the first assistant output
  const { classification, cleanedOutput } = parseClassificationFromOutput(turnAssistantText);
  if (!classification) {
    log.debug(
      `[context-replacement] no classification found in turn output, skipping. sessionKey=${sessionKey ?? "unknown"}`,
    );
    return { replaced: false, classificationType: null, messagesReplaced: 0, messages };
  }

  // Only replace for SIMPLE_TOOL and COMPLEX_ORCHESTRATED
  if (classification.type === TaskClassificationType.DIRECT_CONVERSATION) {
    log.debug(
      `[context-replacement] DIRECT_CONVERSATION, no replacement needed. sessionKey=${sessionKey ?? "unknown"}`,
    );
    return {
      replaced: false,
      classificationType: classification.type,
      messagesReplaced: 0,
      messages,
    };
  }

  // Only replace if there are tool interactions (more than just a single assistant message)
  // If it's just user → assistant (no tools), no need to compress
  const hasToolMessages = messages.slice(userIdx + 1).some((m) => m.role === "toolResult");
  if (!hasToolMessages) {
    log.debug(
      `[context-replacement] ${classification.type} but no tool messages, skipping replacement. sessionKey=${sessionKey ?? "unknown"}`,
    );
    return {
      replaced: false,
      classificationType: classification.type,
      messagesReplaced: 0,
      messages,
    };
  }

  // Build summary
  const userMessage = extractMessageText(messages[userIdx]);
  const rawContextText = collectTurnRawContext(messages, userIdx);

  const executionResult = processClassifiedOutput({
    classification,
    cleanedOutput,
    userMessage,
    rawContextText,
    sessionKey,
  });

  if (!executionResult.hasSummary || !executionResult.formattedSummary) {
    log.warn(
      `[context-replacement] processClassifiedOutput returned no summary for ${classification.type}. sessionKey=${sessionKey ?? "unknown"}`,
    );
    return {
      replaced: false,
      classificationType: classification.type,
      messagesReplaced: 0,
      messages,
    };
  }

  // Build the replacement: keep all messages before (and including) the user message,
  // then replace everything after with a single assistant message containing:
  // 1. The formatted summary (for model awareness that context was compressed)
  // 2. The cleaned output (the actual response, classification tags stripped)
  const summaryContent = [executionResult.formattedSummary, "", cleanedOutput].join("\n");

  const summaryAssistantMessage = {
    role: "assistant" as const,
    content: summaryContent,
  } as unknown as AgentMessage;

  const previousMessages = messages.slice(0, userIdx + 1); // up to and including user message
  const newMessages = [...previousMessages, summaryAssistantMessage];

  log.info(
    `[context-replacement] replaced ${turnMessageCount} turn messages with summary. ` +
      `type=${classification.type} taskId=${executionResult.taskId} ` +
      `originalTokens=${executionResult.summary?.originalContextTokens ?? "?"} ` +
      `summaryTokens=${executionResult.summary?.summaryTokens ?? "?"} ` +
      `sessionKey=${sessionKey ?? "unknown"}`,
  );

  return {
    replaced: true,
    classificationType: classification.type,
    messagesReplaced: turnMessageCount,
    messages: newMessages,
  };
}
