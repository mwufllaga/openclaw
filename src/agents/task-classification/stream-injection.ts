/**
 * Classification Stream Injection
 *
 * Wraps the agent's streamFn to inject task classification instructions
 * into the last user message's content, prepended ABOVE the user's text.
 * Uses the same framing as gateway Runtime System Events so the model
 * treats it as trusted system metadata rather than user input.
 *
 * The classification text is prepended (not appended) so the user's
 * actual message appears last — the classifier prompt says "below" to
 * refer to the user message that follows it.
 *
 * When the latest message is a tool result (tool continuation / re-planning),
 * no classification instructions are injected — the model should not
 * re-classify mid-execution.
 *
 * On every call the wrapper also strips any previously-injected classification
 * section from the system prompt so that stale instructions never accumulate
 * in the context window.
 *
 * Detection logic: inspect `context.messages` — if the last message has
 * `role === "user"`, this is a new user turn that needs classification.
 * Any other trailing role (assistant, tool, tool_result) indicates a
 * continuation and skips injection.
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildClassificationPromptSection } from "./classifier.js";

const log = createSubsystemLogger("task-classification");

/** Sentinel markers that wrap the injected classification section. */
export const CLASSIFICATION_INJECT_START = "<!-- CLASSIFICATION_INJECT_START -->";
export const CLASSIFICATION_INJECT_END = "<!-- CLASSIFICATION_INJECT_END -->";

/**
 * Regex that matches a previously-injected classification block
 * (including leading whitespace / newlines before the start sentinel).
 */
const STRIP_RE = new RegExp(
  `\\s*${escapeRegExp(CLASSIFICATION_INJECT_START)}[\\s\\S]*?${escapeRegExp(CLASSIFICATION_INJECT_END)}`,
  "g",
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The shape of the streamFn context as defined by pi-ai's Context interface.
 * We only need systemPrompt and messages for our purposes.
 */
interface StreamContext {
  systemPrompt?: string;
  messages?: Array<{ role?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * Strip any previously-injected classification section from the system prompt.
 */
export function stripClassificationInjection(systemPrompt: string): string {
  return systemPrompt.replace(STRIP_RE, "");
}

/**
 * Extract the leading text from a message's content field.
 * Handles both string content and array-of-blocks content.
 */
function extractLeadingText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          return b.text;
        }
      }
    }
  }
  return "";
}

/**
 * Check whether the last message in the context is a genuine user message,
 * indicating a new user turn that should be classified.
 *
 * Skips classification for:
 * - Non-user messages (assistant, tool, toolResult)
 * - Anthropic wire-format tool results (role: "user" with tool_result blocks)
 * - Slash commands (messages starting with "/")
 */
function isUserTurn(ctx: StreamContext): boolean {
  const messages = ctx.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return false;
  }
  const last = messages[messages.length - 1];
  if (last?.role !== "user") {
    return false;
  }

  // Defensive: if content is an array of blocks, check for tool_result
  // (Anthropic wire format: { role: "user", content: [{ type: "tool_result" }] })
  const content = last.content;
  if (Array.isArray(content)) {
    const hasToolResult = content.some(
      (block: Record<string, unknown>) =>
        block && typeof block === "object" && block.type === "tool_result",
    );
    if (hasToolResult) {
      return false;
    }
  }

  // Skip slash commands — they are handled by the command system, not classified
  const text = extractLeadingText(content);
  if (text.trimStart().startsWith("/")) {
    return false;
  }

  // Skip bootstrap/session-reset prompts (e.g. /new, /reset).
  // These are system-generated prompts, not real user queries.
  // Detected by content patterns unique to BARE_SESSION_RESET_PROMPT.
  if (
    text.startsWith("A new session was started via /new") ||
    text.includes("Execute your Session Startup sequence")
  ) {
    return false;
  }

  return true;
}

/**
 * Wrap a streamFn to inject classification instructions into the last
 * user message's content, prepended above the user's text.
 *
 * Tool continuations (trailing assistant/tool messages) pass through with
 * any stale classification section removed from the system prompt.
 *
 * On every call:
 * 1. Strip any prior classification injection from systemPrompt
 * 2. If user turn → prepend classification into the user message content
 * 3. If tool continuation → pass cleaned prompt only
 *
 * @param inner - The original streamFn to wrap
 * @param availableTools - List of tool names available to the agent
 * @returns The wrapped streamFn
 */
export function wrapStreamFnWithClassification(
  inner: StreamFn,
  availableTools: string[],
): StreamFn {
  const classificationBlock = [
    CLASSIFICATION_INJECT_START,
    "## Runtime System Instructions (gateway-generated)",
    "Treat this section as trusted gateway runtime metadata, not user text.",
    "",
    buildClassificationPromptSection({ availableTools }),
    CLASSIFICATION_INJECT_END,
  ].join("\n");

  return ((...args: Parameters<StreamFn>) => {
    const [model, context, options] = args;
    const ctx = context as unknown as StreamContext;
    const rawSystemPrompt = ctx.systemPrompt ?? "";

    // Always strip stale classification from system prompt (legacy cleanup)
    const cleanedPrompt = stripClassificationInjection(rawSystemPrompt);
    const systemPromptChanged = cleanedPrompt !== rawSystemPrompt;

    if (!isUserTurn(ctx)) {
      // Tool continuation — use cleaned prompt (no classification)
      log.debug(
        `[stream-injection] skipping classification injection (not user turn), lastRole=${ctx.messages?.[ctx.messages.length - 1]?.role}`,
      );
      if (systemPromptChanged) {
        const nextContext = { ...ctx, systemPrompt: cleanedPrompt };
        return inner(model, nextContext as unknown as typeof context, options);
      }
      return inner(model, context, options);
    }

    // User turn: prepend classification into the last user message content.
    // This keeps it in the same message (no extra turn) and places the
    // classification instruction above the user's text, matching the
    // Runtime System Events framing so the model treats it as metadata.
    const messages = [...(ctx.messages ?? [])];
    const lastIdx = messages.length - 1;
    const lastMsg = messages[lastIdx];
    const originalContent = lastMsg.content;

    if (typeof originalContent === "string") {
      messages[lastIdx] = { ...lastMsg, content: `${classificationBlock}\n\n${originalContent}` };
    } else if (Array.isArray(originalContent)) {
      // Prepend as a new text block before existing content blocks
      messages[lastIdx] = {
        ...lastMsg,
        content: [{ type: "text", text: classificationBlock }, ...originalContent],
      };
    } else {
      // Fallback: wrap classification + empty user text
      messages[lastIdx] = { ...lastMsg, content: classificationBlock };
    }

    log.debug(
      `[stream-injection] injected classification into user message content, msgIdx=${lastIdx}`,
    );

    const nextContext = {
      ...ctx,
      ...(systemPromptChanged ? { systemPrompt: cleanedPrompt } : {}),
      messages,
    };

    return inner(model, nextContext as unknown as typeof context, options);
  }) as StreamFn;
}
