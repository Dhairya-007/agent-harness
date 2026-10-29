import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { Agent } from "../src/agent.js";
import {
  ContextOverflowError,
  MaxStepsExceededError,
  RefusalError,
  ToolInputTruncatedError,
} from "../src/errors.js";
import { defineTool } from "../src/tools/registry.js";
import type { TraceEvent } from "../src/types.js";
import {
  fakeClient,
  lastToolResults,
  message,
  textBlock,
  toolUseBlock,
} from "./helpers.js";

const add = defineTool({
  name: "add",
  description: "Adds two numbers.",
  input: z.object({ a: z.number(), b: z.number() }),
  run: ({ a, b }) => String(a + b),
});

describe("Agent.run", () => {
  it("returns the text of a turn that asks for no tools", async () => {
    const { client } = fakeClient([message({ content: [textBlock("Paris.")] })]);
    const result = await new Agent({ client }).run("Capital of France?");

    assert.equal(result.text, "Paris.");
    assert.equal(result.steps, 1);
    assert.equal(result.stopReason, "end_turn");
  });

  it("defaults to Claude Opus 5.5 and sends no sampling parameters", async () => {
    const fake = fakeClient([message({ content: [textBlock("ok")] })]);
    await new Agent({ client: fake.client }).run("hi");

    const [params] = fake.requests;
    assert.equal(params?.model, "claude-opus-5-5");
    // These are rejected with a 400 on current models.
    assert.ok(!("temperature" in (params ?? {})));
    assert.ok(!("top_p" in (params ?? {})));
    assert.ok(!("top_k" in (params ?? {})));
    assert.ok(!("tool_choice" in (params ?? {})), "forced tool choice is a 400");
  });

  it("sends effort inside output_config, not at the top level", async () => {
    const fake = fakeClient([message({ content: [textBlock("ok")] })]);
    await new Agent({ client: fake.client, effort: "xhigh" }).run("hi");

    assert.deepEqual(fake.requests[0]?.output_config, { effort: "xhigh" });
    assert.ok(!("effort" in (fake.requests[0] ?? {})));
  });

  it("runs a tool and feeds the result back", async () => {
    const fake = fakeClient([
      message({
        content: [toolUseBlock("tu_1", "add", { a: 2, b: 3 })],
        stop_reason: "tool_use",
      }),
      message({ content: [textBlock("It is 5.")] }),
    ]);

    const result = await new Agent({ client: fake.client, tools: [add] }).run("2+3?");

    assert.equal(result.text, "It is 5.");
    assert.equal(result.steps, 2);

    const results = lastToolResults(fake.requests[1]!);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.content, "5");
    assert.equal(results[0]?.tool_use_id, "tu_1");
    assert.equal(results[0]?.is_error, undefined);
  });

  it("returns every parallel result in a single user message", async () => {
    const fake = fakeClient([
      message({
        content: [
          toolUseBlock("tu_1", "add", { a: 1, b: 1 }),
          toolUseBlock("tu_2", "add", { a: 10, b: 5 }),
        ],
        stop_reason: "tool_use",
      }),
      message({ content: [textBlock("2 and 15.")] }),
    ]);

    await new Agent({ client: fake.client, tools: [add] }).run("add both");

    const second = fake.requests[1]!;
    const tail = second.messages.slice(-1);
    assert.equal(tail.length, 1, "results must not be split across messages");
    assert.deepEqual(
      lastToolResults(second).map((block) => block.content),
      ["2", "15"],
    );
  });

  it("sends a failed tool back as is_error rather than dropping it", async () => {
    const fake = fakeClient([
      message({
        content: [toolUseBlock("tu_1", "add", { a: "nope", b: 3 })],
        stop_reason: "tool_use",
      }),
      message({ content: [textBlock("Sorry, retrying.")] }),
    ]);

    const result = await new Agent({ client: fake.client, tools: [add] }).run("go");

    const [block] = lastToolResults(fake.requests[1]!);
    assert.equal(block?.is_error, true);
    assert.match(String(block?.content), /Invalid input/);
    assert.equal(result.steps, 2, "the run continues after a bad call");

    const kinds = result.trace.map((event) => event.type);
    assert.ok(kinds.includes("tool_invalid_input"));
  });

  it("surfaces a denied approval to the model without ending the run", async () => {
    const transfer = defineTool({
      name: "transfer",
      description: "Moves money.",
      input: z.object({ amount: z.number() }),
      approval: (input) =>
        input.amount > 100 ? { allow: false, reason: "needs a human" } : { allow: true },
      run: () => "sent",
    });

    const fake = fakeClient([
      message({
        content: [toolUseBlock("tu_1", "transfer", { amount: 5_000 })],
        stop_reason: "tool_use",
      }),
      message({ content: [textBlock("I'll leave that to you.")] }),
    ]);

    const result = await new Agent({ client: fake.client, tools: [transfer] }).run("pay");

    const [block] = lastToolResults(fake.requests[1]!);
    assert.equal(block?.is_error, true);
    assert.match(String(block?.content), /needs a human/);
    assert.ok(result.trace.some((event) => event.type === "tool_denied"));
  });

  it("raises on a refusal instead of returning an empty answer", async () => {
    const { client } = fakeClient([
      message({
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: "no" },
      }),
    ]);

    await assert.rejects(
      () => new Agent({ client }).run("do something"),
      (error: unknown) => {
        assert.ok(error instanceof RefusalError);
        assert.equal(error.category, "cyber");
        assert.ok(error.trace.length > 0, "the trace comes with the error");
        return true;
      },
    );
  });

  it("refuses to run a tool whose input was truncated at max_tokens", async () => {
    const { client } = fakeClient([
      message({
        content: [toolUseBlock("tu_1", "add", { a: 1 })],
        stop_reason: "max_tokens",
      }),
    ]);

    await assert.rejects(
      () => new Agent({ client, tools: [add] }).run("go"),
      ToolInputTruncatedError,
    );
  });

  it("raises when the conversation outgrows the context window", async () => {
    const { client } = fakeClient([
      message({ content: [], stop_reason: "model_context_window_exceeded" }),
    ]);

    await assert.rejects(() => new Agent({ client }).run("go"), ContextOverflowError);
  });

  it("resumes a paused server-tool turn", async () => {
    const fake = fakeClient([
      message({ content: [textBlock("searching")], stop_reason: "pause_turn" }),
      message({ content: [textBlock("done")] }),
    ]);

    const result = await new Agent({ client: fake.client }).run("look it up");

    assert.equal(result.text, "done");
    assert.equal(fake.requests[1]?.messages.at(-1)?.role, "assistant");
  });

  it("stops at maxSteps rather than looping forever", async () => {
    const script = Array.from({ length: 5 }, () =>
      message({
        content: [toolUseBlock("tu_x", "add", { a: 1, b: 1 })],
        stop_reason: "tool_use",
      }),
    );
    const { client } = fakeClient(script);

    await assert.rejects(
      () => new Agent({ client, tools: [add], maxSteps: 3 }).run("loop"),
      (error: unknown) => {
        assert.ok(error instanceof MaxStepsExceededError);
        assert.equal(error.steps, 3);
        return true;
      },
    );
  });

  it("sends the model back when the verifier rejects its answer", async () => {
    const fake = fakeClient([
      message({ content: [textBlock("42")] }),
      message({ content: [textBlock("The answer is 42, because ...")] }),
    ]);

    const result = await new Agent({
      client: fake.client,
      verify: ({ text }) =>
        text.length < 10 ? { ok: false, feedback: "Explain your reasoning." } : { ok: true },
    }).run("why?");

    assert.equal(result.steps, 2);
    assert.match(result.text, /because/);
    assert.equal(result.verified, true);

    const second = fake.requests[1]!;
    assert.equal(second.messages.at(-1)?.content, "Explain your reasoning.");

    const verifications = result.trace.filter(
      (event): event is Extract<TraceEvent, { type: "verify" }> =>
        event.type === "verify",
    );
    assert.deepEqual(
      verifications.map((event) => event.passed),
      [false, true],
    );
  });

  it("gives up on verification after maxVerifyAttempts", async () => {
    const fake = fakeClient([
      message({ content: [textBlock("a")] }),
      message({ content: [textBlock("b")] }),
    ]);

    const result = await new Agent({
      client: fake.client,
      maxVerifyAttempts: 1,
      verify: () => ({ ok: false, feedback: "not good enough" }),
    }).run("go");

    assert.equal(result.text, "b", "the second answer is returned as-is");
    assert.equal(result.steps, 2);
    assert.equal(
      result.verified,
      false,
      "the caller is told the answer never passed",
    );
  });

  it("reports verified: null when no verifier is configured", async () => {
    const { client } = fakeClient([message({ content: [textBlock("ok")] })]);
    const result = await new Agent({ client }).run("hi");
    assert.equal(result.verified, null);
  });

  it("accumulates usage across every turn", async () => {
    const fake = fakeClient([
      message({
        content: [toolUseBlock("tu_1", "add", { a: 1, b: 1 })],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
      }),
      message({
        content: [textBlock("2")],
        usage: { input_tokens: 150, output_tokens: 10, cache_read_input_tokens: 120 },
      }),
    ]);

    const result = await new Agent({ client: fake.client, tools: [add] }).run("1+1");

    assert.equal(result.usage.inputTokens, 250);
    assert.equal(result.usage.outputTokens, 30);
    assert.equal(result.usage.cacheReadTokens, 200);
  });

  it("records a readable trace of the whole run", async () => {
    const seen: TraceEvent[] = [];
    const fake = fakeClient([
      message({
        content: [toolUseBlock("tu_1", "add", { a: 2, b: 2 })],
        stop_reason: "tool_use",
      }),
      message({ content: [textBlock("4")] }),
    ]);

    const result = await new Agent({
      client: fake.client,
      tools: [add],
      onEvent: (event) => seen.push(event),
    }).run("2+2");

    assert.deepEqual(
      result.trace.map((event) => event.type),
      [
        "turn_start",
        "turn_end",
        "tool_call",
        "tool_result",
        "turn_start",
        "turn_end",
      ],
    );
    assert.deepEqual(seen, result.trace, "onEvent sees exactly the trace");
  });

  it("shares per-run state between tools and keeps runs isolated", async () => {
    const counter = defineTool({
      name: "bump",
      description: "Increments a counter held in run state.",
      input: z.object({}),
      run: (_input, ctx) => {
        const next = ((ctx.state["count"] as number | undefined) ?? 0) + 1;
        ctx.state["count"] = next;
        return String(next);
      },
    });

    const script = () => [
      message({
        content: [toolUseBlock("tu_1", "bump", {})],
        stop_reason: "tool_use" as const,
      }),
      message({
        content: [toolUseBlock("tu_2", "bump", {})],
        stop_reason: "tool_use" as const,
      }),
      message({ content: [textBlock("done")] }),
    ];

    const first = fakeClient(script());
    const agent = new Agent({ client: first.client, tools: [counter] });
    await agent.run("go");
    assert.deepEqual(
      lastToolResults(first.requests[2]!).map((block) => block.content),
      ["2"],
    );

    const second = fakeClient(script());
    await new Agent({ client: second.client, tools: [counter] }).run("go");
    assert.deepEqual(
      lastToolResults(second.requests[1]!).map((block) => block.content),
      ["1"],
      "a new run starts from empty state",
    );
  });
});
