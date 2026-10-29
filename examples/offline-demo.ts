/**
 * The whole harness in one run, with no API key and no cost.
 *
 *   npm run demo
 *
 * The *model* is scripted — a canned sequence of responses replayed in order.
 * Everything else is the real thing: the real agent loop, the real schema
 * validation, the real approval gate, the real context budget and the real
 * verifier. The script is written to walk into each of those in turn:
 *
 *   turn 1  a clean tool call
 *   turn 2  arguments that do not match the schema  -> rejected before the tool runs
 *   turn 3  the model corrects itself
 *   turn 4  a dangerous call                        -> stopped by the approval gate
 *   turn 5  an answer with no citation              -> sent back by the verifier
 *   turn 6  an answer that holds up
 *
 * That is the point of the file. A harness earns its keep on the turns that go
 * wrong, so a demo that only shows the happy path shows nothing.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { Agent, defineTool } from "../src/index.js";
import type { TraceEvent } from "../src/types.js";

// ---------------------------------------------------------------- the tools

/** Padded out to a realistic size — file contents are what fills a transcript. */
const CONFIG = [
  "service: billing",
  "replicas: 3",
  "timeout_ms: 2500",
  "backup: /var/backups/billing-2026-10-01.tar.gz",
  "",
  ...Array.from(
    { length: 40 },
    (_, i) => `feature_flag_${String(i).padStart(2, "0")}: ${i % 3 === 0}`,
  ),
].join("\n");

const readFile = defineTool({
  name: "read_file",
  description: "Reads a text file from the project.",
  input: z.object({ path: z.string().describe("Path relative to the project root") }),
  run: ({ path }) =>
    path === "config.yaml" ? CONFIG : `No such file: ${path}`,
});

const deleteFile = defineTool({
  name: "delete_file",
  description: "Permanently deletes a file.",
  input: z.object({ path: z.string() }),
  // The gate sees validated input, so it can reason about the real path.
  approval: (input) => ({
    allow: false,
    reason: `deleting ${input.path} is irreversible and needs a human`,
  }),
  run: () => "deleted",
});

// ------------------------------------------------------------- the "model"

function text(value: string): Anthropic.ContentBlock {
  return { type: "text", text: value, citations: null } as unknown as Anthropic.ContentBlock;
}

function toolUse(id: string, name: string, input: unknown): Anthropic.ContentBlock {
  return { type: "tool_use", id, name, input } as unknown as Anthropic.ContentBlock;
}

function reply(
  content: Anthropic.ContentBlock[],
  stop: Anthropic.StopReason,
  tokens: [number, number],
): Anthropic.Message {
  return {
    id: "msg_demo",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: tokens[0],
      output_tokens: tokens[1],
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  } as unknown as Anthropic.Message;
}

const SCRIPT: Anthropic.Message[] = [
  reply([toolUse("t1", "read_file", { path: "config.yaml" })], "tool_use", [820, 46]),
  // Missing `path` — the sort of thing eager input streaming lets through.
  reply([toolUse("t2", "read_file", { file: "config.yaml" })], "tool_use", [910, 38]),
  reply([toolUse("t3", "read_file", { path: "config.yaml" })], "tool_use", [1180, 44]),
  reply(
    [toolUse("t4", "delete_file", { path: "/var/backups/billing-2026-10-01.tar.gz" })],
    "tool_use",
    [1340, 52],
  ),
  reply([text("The service is configured and the backup has been handled.")], "end_turn", [1490, 31]),
  reply(
    [
      text(
        "billing runs 3 replicas with a 2500 ms timeout, per config.yaml.\n" +
          "I did not delete the backup — that needs a human.",
      ),
    ],
    "end_turn",
    [1610, 58],
  ),
];

/**
 * Stands in for the SDK client. Structurally compatible with the two methods
 * the harness calls, so the cast is the only shortcut in this file.
 */
function scriptedClient(): Anthropic {
  let turn = 0;
  return {
    messages: {
      async create() {
        const next = SCRIPT[turn++];
        if (!next) throw new Error("script exhausted");
        await new Promise((resolve) => setTimeout(resolve, 260));
        return next;
      },
      async countTokens(params: Anthropic.MessageCountTokensParams) {
        // Estimated from the actual conversation rather than canned, so when
        // the budget clears old tool output the count genuinely falls. A
        // fixture that returns a constant would print "9400 -> 9400" and make
        // working pruning look broken.
        return { input_tokens: Math.round(JSON.stringify(params.messages).length / 4) };
      },
    },
  } as unknown as Anthropic;
}

// ------------------------------------------------------------------ output

const PAD = "   ";

function line(event: TraceEvent): string | null {
  switch (event.type) {
    case "turn_start":
      return `\nturn ${event.step}`;
    case "turn_end":
      return `${PAD}model stopped: ${event.stopReason}  (${event.usage.inputTokens} in / ${event.usage.outputTokens} out)`;
    case "tool_call":
      return `${PAD}-> ${event.name} ${JSON.stringify(event.input)}`;
    case "tool_invalid_input":
      return `${PAD}!! ${event.name} rejected before it ran: ${event.issues}`;
    case "tool_denied":
      return `${PAD}xx ${event.name} denied: ${event.reason}`;
    case "tool_result":
      return `${PAD}<- ${event.name} ${event.ok ? "ok" : "error"} (${event.durationMs}ms)`;
    case "context_pruned":
      return `${PAD}~~ pruned ${event.clearedBlocks} old tool result${event.clearedBlocks === 1 ? "" : "s"}  ${event.tokensBefore} -> ${event.tokensAfter} tokens`;
    case "verify":
      return event.passed
        ? `${PAD}++ verified`
        : `${PAD}<< sent back: ${event.feedback}`;
    default:
      return null;
  }
}

const agent = new Agent({
  client: scriptedClient(),
  system: "You answer questions about this service's configuration.",
  tools: [readFile, deleteFile],
  effort: "low",
  // Low enough that a couple of file reads trip it, so pruning really happens.
  budget: { maxInputTokens: 500, keepRecentResults: 1 },
  verify: ({ text: answer }) =>
    answer.includes("config.yaml")
      ? { ok: true }
      : { ok: false, feedback: "Name the file you read." },
  onEvent(event) {
    const rendered = line(event);
    if (rendered !== null) console.log(rendered);
  },
});

console.log("agent-harness — offline demo (scripted model, no API key)");

const result = await agent.run("Summarise the config, then remove the old backup.");

console.log(`\n${"-".repeat(64)}\n`);
console.log(result.text);
console.log(
  `\n${result.steps} turns · ${result.usage.inputTokens} in / ${result.usage.outputTokens} out · verified: ${result.verified}`,
);
console.log(`${result.trace.length} trace events recorded`);
