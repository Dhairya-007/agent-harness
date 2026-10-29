import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { defineTool, ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext } from "../src/types.js";

const ctx: ToolContext = { step: 1, signal: undefined, state: {} };

const echo = defineTool({
  name: "echo",
  description: "Returns what it was given.",
  input: z.object({ text: z.string(), times: z.number().int().min(1).max(3).optional() }),
  run: ({ text, times }) => text.repeat(times ?? 1),
});

describe("defineTool", () => {
  it("derives a wire schema the API will accept", () => {
    const schema = echo.jsonSchema as unknown as Record<string, unknown>;
    assert.equal(schema["type"], "object");
    assert.equal(schema["additionalProperties"], false, "strict:true requires this");
    assert.deepEqual(schema["required"], ["text"]);
    assert.ok(!("$schema" in schema), "$schema is noise on the wire");
  });

  it("rejects a non-object input schema", () => {
    assert.throws(
      () =>
        defineTool({
          name: "bad",
          description: "x",
          input: z.string(),
          run: () => "ok",
        }),
      /must be an object/,
    );
  });

  it("normalizes a bare string return into a tool output", async () => {
    const result = await echo.run({ text: "hi", times: 2 }, ctx);
    assert.deepEqual(result, { content: "hihi" });
  });
});

describe("ToolRegistry.definitions", () => {
  it("always marks tools strict, since forced tool choice is rejected", () => {
    const [definition] = new ToolRegistry([echo]).definitions();
    assert.equal(definition?.strict, true);
    assert.equal(definition?.name, "echo");
    assert.equal(definition?.eager_input_streaming, undefined);
  });

  it("opts into eager input streaming only when asked", () => {
    const [definition] = new ToolRegistry([echo]).definitions({
      eagerInputStreaming: true,
    });
    assert.equal(definition?.eager_input_streaming, true);
  });

  it("preserves insertion order, which the prompt cache depends on", () => {
    const other = defineTool({
      name: "other",
      description: "x",
      input: z.object({}),
      run: () => "ok",
    });
    assert.deepEqual(new ToolRegistry([echo, other]).names, ["echo", "other"]);
    assert.deepEqual(new ToolRegistry([other, echo]).names, ["other", "echo"]);
  });

  it("refuses duplicate names", () => {
    assert.throws(() => new ToolRegistry([echo, echo]), /duplicate tool name/);
  });
});

describe("ToolRegistry.execute", () => {
  it("runs a valid call", async () => {
    const registry = new ToolRegistry([echo]);
    const outcome = await registry.execute("echo", { text: "ok" }, ctx);
    assert.equal(outcome.content, "ok");
    assert.equal(outcome.isError, undefined);
    assert.equal(outcome.rejection, undefined);
  });

  it("reports an unknown tool back to the model instead of throwing", async () => {
    const registry = new ToolRegistry([echo]);
    const outcome = await registry.execute("nope", {}, ctx);
    assert.equal(outcome.isError, true);
    assert.equal(outcome.rejection, "unknown_tool");
    assert.match(outcome.content, /echo/, "lists what is available");
  });

  it("blocks invalid input before the tool body runs", async () => {
    let ran = false;
    const guarded = defineTool({
      name: "guarded",
      description: "x",
      input: z.object({ count: z.number().int() }),
      run: () => {
        ran = true;
        return "should not happen";
      },
    });
    const outcome = await new ToolRegistry([guarded]).execute(
      "guarded",
      { count: "twelve" },
      ctx,
    );
    assert.equal(ran, false, "validation must precede execution");
    assert.equal(outcome.rejection, "invalid_input");
    assert.equal(outcome.isError, true);
  });

  it("drops a truncated object that the tolerant parser would let through", async () => {
    // Eager input streaming can yield an object missing a later field.
    const outcome = await new ToolRegistry([echo]).execute("echo", { times: 2 }, ctx);
    assert.equal(outcome.rejection, "invalid_input");
    assert.match(outcome.content, /text/);
  });

  it("passes validated values to an approval gate", async () => {
    const seen: unknown[] = [];
    const gated = defineTool({
      name: "gated",
      description: "x",
      input: z.object({ amount: z.number() }),
      approval: (input) => {
        seen.push(input);
        return input.amount > 100
          ? { allow: false, reason: "over the limit" }
          : { allow: true };
      },
      run: () => "transferred",
    });
    const registry = new ToolRegistry([gated]);

    const allowed = await registry.execute("gated", { amount: 10 }, ctx);
    assert.equal(allowed.content, "transferred");

    const denied = await registry.execute("gated", { amount: 500 }, ctx);
    assert.equal(denied.rejection, "denied");
    assert.equal(denied.isError, true);
    assert.match(denied.content, /over the limit/);

    assert.deepEqual(seen, [{ amount: 10 }, { amount: 500 }]);
  });

  it("turns a thrown tool into an error result the model can read", async () => {
    const boom = defineTool({
      name: "boom",
      description: "x",
      input: z.object({}),
      run: () => {
        throw new Error("disk on fire");
      },
    });
    const outcome = await new ToolRegistry([boom]).execute("boom", {}, ctx);
    assert.equal(outcome.isError, true);
    assert.match(outcome.content, /disk on fire/);
  });
});
