import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;

/**
 * Regex to strip the entire <task_classification>...</task_classification> block
 * (including all content between the opening and closing tags).
 */
const CLASSIFICATION_BLOCK_RE =
  /\s*<\s*task_classification\s*>[\s\S]*?<\s*\/\s*task_classification\s*>/gi;
/**
 * Regex to strip a partial (unclosed) <task_classification> block at the end of
 * streaming text where the closing tag hasn't arrived yet.
 */
const CLASSIFICATION_PARTIAL_RE = /\s*<\s*task_classification\s*>[\s\S]*$/i;
const CLASSIFICATION_QUICK_RE = /<\s*\/?\s*task_classification\b/i;

function stripRelevantMemoriesTags(text: string): string {
  if (!text || !MEMORY_TAG_QUICK_RE.test(text)) {
    return text;
  }
  MEMORY_TAG_RE.lastIndex = 0;

  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inMemoryBlock = false;

  for (const match of text.matchAll(MEMORY_TAG_RE)) {
    const idx = match.index ?? 0;
    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    const isClose = match[1] === "/";
    if (!inMemoryBlock) {
      result += text.slice(lastIndex, idx);
      if (!isClose) {
        inMemoryBlock = true;
      }
    } else if (isClose) {
      inMemoryBlock = false;
    }

    lastIndex = idx + match[0].length;
  }

  if (!inMemoryBlock) {
    result += text.slice(lastIndex);
  }

  return result;
}

function stripClassificationTags(text: string): string {
  if (!text || !CLASSIFICATION_QUICK_RE.test(text)) {
    return text;
  }
  // First strip complete blocks
  let result = text.replace(CLASSIFICATION_BLOCK_RE, "");
  // Then strip any partial (unclosed) block at the end of the text
  // (happens during streaming before the closing tag arrives)
  result = result.replace(CLASSIFICATION_PARTIAL_RE, "");
  return result;
}

export function stripAssistantInternalScaffolding(text: string): string {
  const withoutReasoning = stripReasoningTagsFromText(text, { mode: "preserve", trim: "start" });
  const withoutMemory = stripRelevantMemoriesTags(withoutReasoning);
  return stripClassificationTags(withoutMemory).trimStart();
}
