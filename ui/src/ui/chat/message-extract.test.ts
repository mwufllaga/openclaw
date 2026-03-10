import { describe, expect, it } from "vitest";
import {
  extractText,
  extractTextCached,
  extractThinking,
  extractThinkingCached,
  extractClassification,
  extractClassificationCached,
} from "./message-extract.ts";

describe("extractTextCached", () => {
  it("matches extractText output", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Hello there" }],
    };
    expect(extractTextCached(message)).toBe(extractText(message));
  });

  it("returns consistent output for repeated calls", () => {
    const message = {
      role: "user",
      content: "plain text",
    };
    expect(extractTextCached(message)).toBe("plain text");
    expect(extractTextCached(message)).toBe("plain text");
  });

  it("strips assistant relevant-memories scaffolding", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "<relevant-memories>",
            "Internal memory context",
            "</relevant-memories>",
            "Final user answer",
          ].join("\n"),
        },
      ],
    };
    expect(extractText(message)).toBe("Final user answer");
    expect(extractTextCached(message)).toBe("Final user answer");
  });
});

describe("extractThinkingCached", () => {
  it("matches extractThinking output", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan A" }],
    };
    expect(extractThinkingCached(message)).toBe(extractThinking(message));
  });

  it("returns consistent output for repeated calls", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "Plan A" }],
    };
    expect(extractThinkingCached(message)).toBe("Plan A");
    expect(extractThinkingCached(message)).toBe("Plan A");
  });
});

describe("extractClassification", () => {
  it("extracts classification info from assistant message", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "<task_classification>",
            "<analysis>",
            "The user is asking to check the weather. This requires a tool call.",
            "</analysis>",
            "<conclusion>",
            "type: SIMPLE_TOOL",
            "</conclusion>",
            "</task_classification>",
            "Let me check the weather for you.",
          ].join("\n"),
        },
      ],
    };
    const result = extractClassification(message);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("SIMPLE_TOOL");
    expect(result!.analysis).toContain("weather");
  });

  it("returns null for user messages", () => {
    const message = {
      role: "user",
      content:
        "<task_classification><analysis>test</analysis><conclusion>type: SIMPLE_TOOL</conclusion></task_classification>",
    };
    expect(extractClassification(message)).toBeNull();
  });

  it("returns null when no classification tags", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "Just a normal response." }],
    };
    expect(extractClassification(message)).toBeNull();
  });

  it("handles COMPLEX_ORCHESTRATED type", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "<task_classification><analysis>Multi-step task with dependencies</analysis><conclusion>type: COMPLEX_ORCHESTRATED</conclusion></task_classification>Response",
        },
      ],
    };
    const result = extractClassification(message);
    expect(result!.type).toBe("COMPLEX_ORCHESTRATED");
  });

  it("handles DIRECT_CONVERSATION type", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "<task_classification><analysis>This is casual chat, no tools needed.</analysis><conclusion>type: DIRECT_CONVERSATION</conclusion></task_classification>Hi!",
        },
      ],
    };
    const result = extractClassification(message);
    expect(result!.type).toBe("DIRECT_CONVERSATION");
  });
});

describe("extractClassificationCached", () => {
  it("returns consistent output for repeated calls", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "<task_classification><analysis>Weather check needed</analysis><conclusion>type: SIMPLE_TOOL</conclusion></task_classification>Response",
        },
      ],
    };
    const first = extractClassificationCached(message);
    const second = extractClassificationCached(message);
    expect(first).toBe(second);
    expect(first!.type).toBe("SIMPLE_TOOL");
  });
});

describe("extractText strips classification tags", () => {
  it("removes classification block from displayed text", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "<task_classification><analysis>Some analysis here about the task</analysis><conclusion>type: SIMPLE_TOOL</conclusion></task_classification>\nHere is my response.",
        },
      ],
    };
    const text = extractText(message);
    expect(text).not.toContain("task_classification");
    expect(text).not.toContain("analysis");
    expect(text).toContain("Here is my response");
  });
});
