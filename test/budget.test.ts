import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { ContextBudget } from "../src/context/budget.js";
import { fakeClient, toolResultsIn } from "./helpers.js";

/** One tool_use turn followed by its tool_result turn. */
function exchange(id: string, payload: string): Anthropic.MessageParam[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "read", input: { path: id } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: payload }],
    },
  ];
}

function conversation(count: number, payloadSize = 4_000): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "go" }];
  for (let i = 0; i < count; i++) {
    messages.push(...exchange(`t${i}`, "x".repeat(payloadSize)));
  }
  return messages;
}

function toolResults(
  messages: readonly Anthropic.MessageParam[],
): Anthropic.ToolResultBlockParam[] {
  return messages.flatMap((message) => toolResultsIn(message));
}

describe("ContextBudget.prune", () => {
  const { client } = fakeClient([]);

  it("clears the oldest results and keeps the most recent ones intact", () => {
    const budget = new ContextBudget(client, "claude-opus-5-5", {
      maxInputTokens: 1_000,
      keepRecentResults: 2,
    });
    const messages = conversation(6);

    const { messages: pruned, clearedBlocks } = budget.prune(messages, 2_000);

    assert.ok(clearedBlocks > 0, "something should have been cleared");
    const results = toolResults(pruned);
    assert.equal(results.length, 6, "no block is removed, only emptied");

    // The last two payloads must survive untouched.
    assert.equal(results.at(-1)?.content, "x".repeat(4_000));
    assert.equal(results.at(-2)?.content, "x".repeat(4_000));
    // The oldest must not.
    assert.notEqual(results[0]?.content, "x".repeat(4_000));
  });

  it("never clears more than it needs to", () => {
    const budget = new ContextBudget(client, "claude-opus-5-5", {
      maxInputTokens: 1_000,
      keepRecentResults: 0,
    });
    // Each payload is ~1000 tokens; freeing 1500 should take two blocks.
    const { clearedBlocks } = budget.prune(conversation(6), 1_500);
    assert.equal(clearedBlocks, 2);
  });

  it("leaves the caller's messages untouched", () => {
    const budget = new ContextBudget(client, "claude-opus-5-5", {
      maxInputTokens: 1_000,
      keepRecentResults: 0,
    });
    const messages = conversation(4);
    const before = JSON.stringify(messages);
    budget.prune(messages, 10_000);
    assert.equal(JSON.stringify(messages), before);
  });

  it("preserves the tool_use/tool_result pairing the API requires", () => {
    const budget = new ContextBudget(client, "claude-opus-5-5", {
      maxInputTokens: 1_000,
      keepRecentResults: 0,
    });
    const { messages: pruned } = budget.prune(conversation(4), 10_000);
    const ids = toolResults(pruned).map((block) => block.tool_use_id);
    assert.deepEqual(ids, ["t0", "t1", "t2", "t3"]);
  });

  it("does nothing when every result is already recent", () => {
    const budget = new ContextBudget(client, "claude-opus-5-5", {
      maxInputTokens: 1_000,
      keepRecentResults: 10,
    });
    const { clearedBlocks } = budget.prune(conversation(3), 10_000);
    assert.equal(clearedBlocks, 0);
  });
});

describe("ContextBudget.fit", () => {
  it("skips pruning — and the second count — when already under budget", async () => {
    const fake = fakeClient([], { tokenCounter: () => 500 });
    const budget = new ContextBudget(fake.client, "claude-opus-5-5", {
      maxInputTokens: 1_000,
    });

    const messages = conversation(4);
    const result = await budget.fit({ messages });

    assert.equal(result.clearedBlocks, 0);
    assert.equal(result.tokensBefore, 500);
    assert.equal(result.tokensAfter, 500);
    assert.equal(fake.tokenCounts.length, 1, "one count, not two");
    assert.equal(result.messages, messages, "same array back");
  });

  it("prunes and re-measures when over budget", async () => {
    let call = 0;
    const fake = fakeClient([], { tokenCounter: () => (call++ === 0 ? 9_000 : 1_200) });
    const budget = new ContextBudget(fake.client, "claude-opus-5-5", {
      maxInputTokens: 2_000,
      keepRecentResults: 1,
    });

    const result = await budget.fit({ messages: conversation(6) });

    assert.ok(result.clearedBlocks > 0);
    assert.equal(result.tokensBefore, 9_000);
    assert.equal(result.tokensAfter, 1_200);
    assert.equal(fake.tokenCounts.length, 2);
  });

  it("counts tokens against the model, not a local tokenizer", async () => {
    const fake = fakeClient([], { tokenCounter: () => 10 });
    const budget = new ContextBudget(fake.client, "claude-opus-5-5", {
      maxInputTokens: 1_000,
    });

    await budget.fit({
      messages: [{ role: "user", content: "hello" }],
      system: "be brief",
    });

    assert.equal(fake.tokenCounts[0]?.model, "claude-opus-5-5");
    assert.equal(fake.tokenCounts[0]?.system, "be brief");
  });
});
