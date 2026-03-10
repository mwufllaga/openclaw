import { describe, it, expect, vi } from "vitest";
import { CLASSIFICATION_OPEN_TAG } from "./classifier.js";
import {
  wrapStreamFnWithClassification,
  stripClassificationInjection,
  CLASSIFICATION_INJECT_START,
  CLASSIFICATION_INJECT_END,
} from "./stream-injection.js";

describe("wrapStreamFnWithClassification", () => {
  const tools = ["web_search", "file_read"];

  function makeStreamFn() {
    return vi.fn((_model: unknown, context: unknown, _options?: unknown) => {
      return { context }; // pass-through so we can inspect
    });
  }

  /** Helper to extract passed messages from the inner mock call */
  function getPassedMessages(inner: ReturnType<typeof makeStreamFn>, callIndex = 0) {
    return (
      inner.mock.calls[callIndex][1] as { messages: Array<{ role: string; content: unknown }> }
    ).messages;
  }

  /** Helper to extract passed systemPrompt from the inner mock call */
  function getPassedSystemPrompt(inner: ReturnType<typeof makeStreamFn>, callIndex = 0) {
    return (inner.mock.calls[callIndex][1] as { systemPrompt: string }).systemPrompt;
  }

  /** Check if the last user message's content has classification injected (prepended) */
  function lastUserMsgHasClassification(inner: ReturnType<typeof makeStreamFn>, callIndex = 0) {
    const msgs = getPassedMessages(inner, callIndex);
    const last = msgs[msgs.length - 1];
    if (!last) {
      return false;
    }
    const content = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    return (
      content.includes(CLASSIFICATION_OPEN_TAG) && content.includes(CLASSIFICATION_INJECT_START)
    );
  }

  it("injects classification prepended into last user message content", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    const context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [{ role: "user", content: "hello" }],
    };

    void wrapped("model", context);

    expect(inner).toHaveBeenCalledTimes(1);
    const msgs = getPassedMessages(inner);
    // No extra message — classification is inlined into the user message
    expect(msgs.length).toBe(1);
    const userMsg = msgs[0];
    expect(userMsg.role).toBe("user");
    // Classification is prepended before the user's text
    const content = userMsg.content as string;
    expect(content).toContain(CLASSIFICATION_INJECT_START);
    expect(content).toContain(CLASSIFICATION_INJECT_END);
    expect(content).toContain(CLASSIFICATION_OPEN_TAG);
    expect(content).toContain("SIMPLE_TOOL");
    expect(content).toContain("web_search");
    expect(content).toContain("file_read");
    expect(content).toContain("Runtime System Instructions (gateway-generated)");
    // User text appears after classification
    const classEnd = content.indexOf(CLASSIFICATION_INJECT_END);
    const userTextPos = content.indexOf("hello");
    expect(userTextPos).toBeGreaterThan(classEnd);
    // System prompt unchanged
    expect(getPassedSystemPrompt(inner)).toBe("You are a helpful assistant.");
  });

  it("does NOT inject when last message is a tool result (continuation)", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    const context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "tool_call..." },
        { role: "tool", content: "result" },
      ],
    };

    void wrapped("model", context);

    expect(lastUserMsgHasClassification(inner)).toBe(false);
    expect(getPassedMessages(inner).length).toBe(3);
    expect(getPassedSystemPrompt(inner)).toBe("You are a helpful assistant.");
  });

  it("does NOT inject when last message is from assistant", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    const context = {
      systemPrompt: "test",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello!" },
      ],
    };

    void wrapped("model", context);

    expect(lastUserMsgHasClassification(inner)).toBe(false);
    expect(getPassedMessages(inner).length).toBe(2);
  });

  it("does NOT inject when last message is role=user with tool_result content (Anthropic wire format)", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    const context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "toolu_01", name: "web_search", input: { query: "weather" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: "Sunny, 25°C",
            },
          ],
        },
      ],
    };

    void wrapped("model", context);

    expect(lastUserMsgHasClassification(inner)).toBe(false);
    expect(getPassedMessages(inner).length).toBe(3);
    expect(getPassedSystemPrompt(inner)).toContain("You are a helpful assistant.");
  });

  it("does NOT inject when user message starts with / (slash command, string content)", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    const context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [{ role: "user", content: "/help" }],
    };

    void wrapped("model", context);

    expect(lastUserMsgHasClassification(inner)).toBe(false);
    expect(getPassedMessages(inner).length).toBe(1);
  });

  it("does NOT inject when user message starts with / (slash command, array content)", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    const context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [{ role: "user", content: [{ type: "text", text: "/model kimi-k2" }] }],
    };

    void wrapped("model", context);

    expect(lastUserMsgHasClassification(inner)).toBe(false);
  });

  it("does NOT inject when user message starts with / after leading whitespace", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    const context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [{ role: "user", content: "  /status" }],
    };

    void wrapped("model", context);

    expect(lastUserMsgHasClassification(inner)).toBe(false);
  });

  it("does NOT inject for BARE_SESSION_RESET_PROMPT (/new bootstrap)", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    const bootstrapPrompt =
      "A new session was started via /new or /reset. Execute your Session Startup sequence now - " +
      "read the required files before responding to the user. Then greet the user in your configured persona.";

    const context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [{ role: "user", content: bootstrapPrompt }],
    };

    void wrapped("model", context);

    expect(lastUserMsgHasClassification(inner)).toBe(false);
    expect(getPassedMessages(inner).length).toBe(1);
    expect(getPassedSystemPrompt(inner)).toContain("You are a helpful assistant.");
  });

  it("does NOT inject for bootstrap prompt in array content format", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    const context = {
      systemPrompt: "You are a helpful assistant.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "A new session was started via /new or /reset. Execute your Session Startup sequence now.",
            },
          ],
        },
      ],
    };

    void wrapped("model", context);

    expect(lastUserMsgHasClassification(inner)).toBe(false);
  });

  it("injects again when a new user message arrives after tool continuation", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    // Call 1: user turn → inject
    void wrapped("model", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "search for weather" }],
    });
    // Call 2: tool continuation → skip
    void wrapped("model", {
      systemPrompt: "test",
      messages: [
        { role: "user", content: "search for weather" },
        { role: "assistant", content: "calling tool..." },
        { role: "tool", content: "sunny 25C" },
      ],
    });
    // Call 3: new user message → inject again
    void wrapped("model", {
      systemPrompt: "test",
      messages: [
        { role: "user", content: "search for weather" },
        { role: "assistant", content: "It is sunny 25C." },
        { role: "user", content: "now tell me a joke" },
      ],
    });

    expect(inner).toHaveBeenCalledTimes(3);

    expect(lastUserMsgHasClassification(inner, 0)).toBe(true);
    expect(lastUserMsgHasClassification(inner, 1)).toBe(false);
    expect(lastUserMsgHasClassification(inner, 2)).toBe(true);
  });

  it("strips stale classification from systemPrompt on tool continuation", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    // Simulate a system prompt that still contains a prior injection (legacy)
    const stalePrompt = [
      "You are a helpful assistant.",
      "",
      CLASSIFICATION_INJECT_START,
      "## Task Classification (mandatory, internal)",
      "old classification instructions...",
      CLASSIFICATION_INJECT_END,
    ].join("\n");

    // Tool continuation call with a stale prompt
    void wrapped("model", {
      systemPrompt: stalePrompt,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "calling tool..." },
        { role: "tool", content: "result" },
      ],
    });

    const sp = getPassedSystemPrompt(inner);
    expect(sp).not.toContain(CLASSIFICATION_INJECT_START);
    expect(sp).not.toContain("old classification instructions");
    expect(sp).toContain("You are a helpful assistant.");
  });

  it("strips stale classification from systemPrompt on user turn (legacy cleanup)", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    // Simulate a system prompt that still contains a prior injection (legacy)
    const stalePrompt = [
      "You are a helpful assistant.",
      "",
      CLASSIFICATION_INJECT_START,
      "old stale classification from previous turn",
      CLASSIFICATION_INJECT_END,
    ].join("\n");

    // User turn with a stale prompt
    void wrapped("model", {
      systemPrompt: stalePrompt,
      messages: [{ role: "user", content: "hello" }],
    });

    const sp = getPassedSystemPrompt(inner);
    // Should NOT contain old stale content
    expect(sp).not.toContain("old stale classification");
    expect(sp).not.toContain(CLASSIFICATION_INJECT_START);
    expect(sp).toContain("You are a helpful assistant.");
    // Classification should be in messages, not systemPrompt
    expect(sp).not.toContain(CLASSIFICATION_OPEN_TAG);
    expect(lastUserMsgHasClassification(inner)).toBe(true);
  });

  it("does NOT inject when messages array is empty", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    void wrapped("model", { systemPrompt: "test", messages: [] });

    expect(lastUserMsgHasClassification(inner)).toBe(false);
  });

  it("handles missing systemPrompt gracefully", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    void wrapped("model", { messages: [{ role: "user", content: "hello" }] });

    expect(lastUserMsgHasClassification(inner)).toBe(true);
    const msgs = getPassedMessages(inner);
    expect(msgs.length).toBe(1);
  });

  it("handles empty tool list", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, []);

    void wrapped("model", {
      systemPrompt: "test",
      messages: [{ role: "user", content: "hi" }],
    });

    const msgs = getPassedMessages(inner);
    const userMsg = msgs[msgs.length - 1];
    const content =
      typeof userMsg.content === "string" ? userMsg.content : JSON.stringify(userMsg.content);
    expect(content).toContain("No tools currently available");
  });

  it("preserves options passthrough", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    const options = { maxTokens: 4096 };
    void wrapped(
      "model",
      {
        systemPrompt: "test",
        messages: [{ role: "user", content: "hi" }],
      },
      options,
    );

    expect(inner).toHaveBeenCalledWith("model", expect.anything(), options);
  });

  it("preserves non-systemPrompt context fields", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    const context = {
      systemPrompt: "test",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "web_search" }],
    };

    void wrapped("model", context);

    const passedContext = inner.mock.calls[0][1] as {
      messages: unknown[];
      tools: unknown[];
    };
    // Classification is inlined — no extra message
    expect(passedContext.messages.length).toBe(1);
    expect((passedContext.messages[0] as { content: string }).content).toContain("hi");
    expect((passedContext.messages[0] as { content: string }).content).toContain(
      CLASSIFICATION_INJECT_START,
    );
    expect(passedContext.tools).toEqual([{ name: "web_search" }]);
  });

  it("does NOT mutate the original messages array", () => {
    const inner = makeStreamFn();
    const wrapped = wrapStreamFnWithClassification(inner, tools);

    const originalMessages = [{ role: "user", content: "hello" }];
    const context = {
      systemPrompt: "test",
      messages: originalMessages,
    };

    void wrapped("model", context);

    // Original array and message must not be modified
    expect(originalMessages.length).toBe(1);
    expect(originalMessages[0].content).toBe("hello");
    // Passed messages has same length but content is different (classification prepended)
    const passedMsgs = getPassedMessages(inner);
    expect(passedMsgs.length).toBe(1);
    expect((passedMsgs[0] as { content: string }).content).toContain(CLASSIFICATION_INJECT_START);
    expect((passedMsgs[0] as { content: string }).content).toContain("hello");
  });
});

describe("stripClassificationInjection", () => {
  it("removes a classification block between sentinels", () => {
    const prompt = [
      "You are a helpful assistant.",
      "",
      CLASSIFICATION_INJECT_START,
      "classification stuff here",
      CLASSIFICATION_INJECT_END,
    ].join("\n");

    const result = stripClassificationInjection(prompt);
    expect(result).toBe("You are a helpful assistant.");
    expect(result).not.toContain(CLASSIFICATION_INJECT_START);
  });

  it("returns unchanged string when no sentinels present", () => {
    const prompt = "You are a helpful assistant.";
    expect(stripClassificationInjection(prompt)).toBe(prompt);
  });

  it("handles multiple injections (strips all)", () => {
    const block = [CLASSIFICATION_INJECT_START, "block content", CLASSIFICATION_INJECT_END].join(
      "\n",
    );
    const prompt = `base prompt\n\n${block}\n\nmore text\n\n${block}`;

    const result = stripClassificationInjection(prompt);
    expect(result).not.toContain(CLASSIFICATION_INJECT_START);
    expect(result).toContain("base prompt");
    expect(result).toContain("more text");
  });
});
