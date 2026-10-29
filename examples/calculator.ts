/**
 * The smallest useful thing: two tools, one run, and the trace printed out.
 *
 *   ANTHROPIC_API_KEY=... npm run example:calculator
 */
import { z } from "zod";
import { Agent, defineTool } from "../src/index.js";

const add = defineTool({
  name: "add",
  description: "Adds two numbers and returns the sum.",
  input: z.object({
    a: z.number().describe("The first addend"),
    b: z.number().describe("The second addend"),
  }),
  run: ({ a, b }) => String(a + b),
});

const sqrt = defineTool({
  name: "sqrt",
  description: "Returns the square root of a non-negative number.",
  input: z.object({ value: z.number().min(0).describe("A non-negative number") }),
  run: ({ value }) => String(Math.sqrt(value)),
});

const agent = new Agent({
  system:
    "You are a careful calculator. Use the tools for every arithmetic step " +
    "rather than computing in your head, and show the final number plainly.",
  tools: [add, sqrt],
  effort: "low",
  onEvent(event) {
    if (event.type === "tool_call") {
      console.log(`  → ${event.name}(${JSON.stringify(event.input)})`);
    }
    if (event.type === "tool_result") {
      console.log(`  ← ${event.name} ${event.ok ? "ok" : "ERROR"} (${event.durationMs}ms)`);
    }
  },
});

const result = await agent.run(
  "What is the square root of 144 plus 37? Then add 8 to that.",
);

console.log(`\n${result.text}\n`);
console.log(
  `${result.steps} turns · ${result.usage.inputTokens} in / ${result.usage.outputTokens} out` +
    (result.usage.cacheReadTokens
      ? ` · ${result.usage.cacheReadTokens} cached`
      : ""),
);
