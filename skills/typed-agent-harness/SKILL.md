---
name: typed-agent-harness
description: Builds the production scaffolding around an LLM agent loop — tools whose Zod or Pydantic schema both generates the wire schema and validates what comes back, declarative per-tool approval gates that read typed values, a context budget that empties old tool output without breaking tool_use/tool_result pairing, a verification pass that can send the model back, typed errors for refusal and truncation and overflow, and a readable trace of the whole run. Use this skill whenever the user wants to build, scaffold, restructure or "productionise" an agent, a tool-calling loop, a tool registry, or an agentic feature on the Anthropic or OpenAI SDK — and especially when they describe needs the stock SDK tool runner doesn't express: human approval before risky tool calls, long runs that outgrow the context window, agents whose answers must be checked before they're returned, or an audit trail of what the agent did. Reach for it when the user says things like "my agent needs to ask before it deletes anything", "it runs out of context on long tasks", "I need to know why it did that", or "the loop works but I don't trust it yet", even if they never use the word harness.
---

# Typed agent harness

The loop is thirty lines. Everything that makes it survive contact with a real task
is the other ninety percent, and that is what this builds: validated tool inputs,
approval gates, a context budget, a verification pass, honest errors, and a trace
you can read.

## First: does this project need a harness at all?

Often it doesn't, and saying so is more useful than building one. The stock SDK tool
runner drives the same loop, it's maintained by the provider, and for a
straightforward custom-tool agent it is less code and fewer bugs than anything built
here.

Build the harness when the project needs something the runner doesn't express:

| | SDK tool runner | this harness |
| --- | --- | --- |
| Runs the loop | yes | yes |
| Typed tools from a schema | yes | yes |
| Per-turn hooks | yes | yes (`onEvent`) |
| **Validates input before the tool body runs** | you do it | built in |
| **Approval gate over parsed arguments** | inside `run()` | declarative, per tool |
| **Context budget with tool-output pruning** | — | yes |
| **Verification pass that can send the model back** | — | yes |
| **Distinct errors for refusal / truncation / overflow** | — | yes |
| **Structured trace of the whole run** | — | yes |

If the user needs two or fewer of the bold rows, add those pieces to the runner
instead of replacing it — the validation and gating patterns below work equally well
inside a runner's tool bodies. Say that plainly rather than building the full
structure because it was asked for. Recommend the whole harness when they need the
loop to *branch* differently: resume on pause, send back on failed verification,
prune before the window fills.

Target shape when you do build it: around 600 lines, two dependencies, readable in
one sitting. If it grows past that, something in it wants to be the caller's problem
instead.

## Build order

Build in this order, because each piece is testable before the next exists, and the
loop is last so it's assembled from parts that already work:

1. **Types** — the vocabulary: tool, context, output, approval decision, trace
   event, run result.
2. **Tool definition** — one schema, two jobs.
3. **Registry** — holds the tools, executes a call, never throws for a tool-level
   problem.
4. **Context budget** — measure, prune, measure again.
5. **Errors** — the unrecoverable states, each carrying the trace.
6. **The loop** — branch on the stop reason, assemble the rest.
7. **Verification** — the last gate before the answer is returned.

Write tests against a scripted fake client as you go, not after. Read
`references/testing.md` before step 2 — the fake client shapes how every other piece
gets written, and retrofitting it is painful. A suite that replays scripted
responses exercises the whole loop, including the failure paths, without spending a
token.

For the loop's stop-reason branching, parallel execution and resume behaviour, read
`references/loop.md` at step 6.

---

## 1. One schema, two jobs

A tool definition takes a schema and uses it twice: converted to JSON Schema for the
request, and run as a validator on what comes back. They cannot drift apart because
there's only one of them.

```ts
export function defineTool<Schema extends z.ZodType>(opts: {
  name: string;
  description: string;          // the biggest lever on correct calls — write it long
  input: Schema;
  approval?: ApprovalPolicy<z.infer<Schema>>;
  run(input: z.infer<Schema>, ctx: ToolContext): string | ToolOutput | Promise<string | ToolOutput>;
}): HarnessTool<z.infer<Schema>> {
  const jsonSchema = z.toJSONSchema(opts.input, { target: "draft-7" }) as Record<string, unknown>;

  // The API wants a bare object schema. `$schema` is noise on the wire, and
  // strict mode additionally requires `additionalProperties: false`.
  delete jsonSchema["$schema"];
  if (jsonSchema["type"] !== "object") {
    throw new TypeError(`tool "${opts.name}": input schema must be an object`);
  }
  jsonSchema["additionalProperties"] ??= false;

  return {
    name: opts.name,
    description: opts.description,
    jsonSchema,
    approval: opts.approval ?? "auto",
    parse(raw) {
      const parsed = opts.input.safeParse(raw);
      if (parsed.success) return { ok: true, value: parsed.data };
      return {
        ok: false,
        issues: parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      };
    },
    async run(input, ctx) {
      const out = await opts.run(input, ctx);
      return typeof out === "string" ? { content: out } : out;
    },
  };
}
```

The second half — validating before `run` is reached — is not belt-and-braces.
Tools go out with strict schemas, but with eager input streaming the server stops
validating tool input, and the SDK's tolerant parser hands back a silently truncated
object rather than throwing. A tool that trusts its input runs on half an argument
and reports success.

Keep `run` typed on `z.infer<Schema>` so it is impossible to write a tool body that
reads an unvalidated field. That's the point of doing this in the type system rather
than with a convention.

In Python, the same structure is a Pydantic model: `model_json_schema()` for the
wire, `model_validate()` for the guard.

## 2. Approval gates that see real values

```ts
const transfer = defineTool({
  name: "transfer",
  description: "Moves money between two accounts.",
  input: z.object({ from: z.string(), to: z.string(), amount: z.number().positive() }),
  approval(input, ctx) {
    if (input.amount <= 100) return { allow: true };
    return { allow: false, reason: "transfers over $100 need a human" };
  },
  run: ({ from, to, amount }) => ledger.move(from, to, amount),
});
```

Two decisions here are load-bearing:

**The gate runs after validation**, so it reads typed values rather than guessing at
raw JSON. A gate comparing `input.amount <= 100` against a string, or against a
value truncated from `5000` to `500`, reaches a different answer than intended.

**A denial is not an exception.** It goes back to the model as an error result, and
the model routes around it — "I can't move $5,000 myself; here's the command for you
to run." Thrown instead, the same information ends the run and the user gets a stack
trace in place of an answer.

Keep the policy beside the schema rather than inside `run`, so that "which
operations need a human?" is answerable by reading the tool list instead of every
tool body.

## 3. A registry that doesn't throw

```ts
async execute(name: string, rawInput: unknown, ctx: ToolContext): Promise<ExecutionOutcome> {
  const tool = this.#tools.get(name);
  if (!tool) return { content: `No tool named "${name}". Available: ${this.names.join(", ")}.`, isError: true, rejection: "unknown_tool", durationMs: elapsed() };

  const parsed = tool.parse(rawInput);
  if (!parsed.ok) return { content: `Invalid input for "${name}": ${parsed.issues}. Call it again with arguments matching the schema.`, isError: true, rejection: "invalid_input", detail: parsed.issues, durationMs: elapsed() };

  if (typeof tool.approval === "function") {
    const decision = await tool.approval(parsed.value, ctx);
    if (!decision.allow) return { content: `Call to "${name}" was not approved: ${decision.reason}`, isError: true, rejection: "denied", detail: decision.reason, durationMs: elapsed() };
  }

  try {
    return { ...(await tool.run(parsed.value, ctx)), durationMs: elapsed() };
  } catch (error) {
    return { content: `Tool "${name}" failed: ${error instanceof Error ? error.message : String(error)}`, isError: true, durationMs: elapsed() };
  }
}
```

An unknown tool, bad arguments, a refused approval and a thrown exception all come
back as an error result, because the model can read those and correct itself — while
an exception would end the run. The error message is written *for the model*: it says
what was wrong and what to do about it. "Invalid input" alone gets a retry of the
same mistake.

Two registry details that matter later:

- **Reject duplicate tool names at registration**, not at call time. A shadowed tool
  is a silent wrong answer.
- **Preserve insertion order.** Tool definitions render first in the cached prefix,
  so sorting or rebuilding the list per request invalidates the prompt cache for
  every following request.

## 4. A context budget

Agent transcripts are mostly tool output, and tool output stops being load-bearing
once the model has acted on it.

```ts
budget: { maxInputTokens: 120_000, keepRecentResults: 4 }
```

Before each turn: count the request with the API's own token counter, and if it's
over, clear the oldest tool results until the projected saving covers the overage.
Then count again.

Three decisions that are easy to get wrong:

**Empty the block, don't remove it.** The API requires every `tool_use` to be
answered by a `tool_result` with the matching id. Removing the block breaks the
pairing and the next request is a 400. Replace the payload with a placeholder and
leave the block and its id in place:

```ts
{ ...block, content: "[earlier tool output cleared to stay within the context budget]" }
```

**Count with the API, not a local tokenizer.** A local tokenizer disagrees with the
server and drifts between model generations. Use a cheap character estimate to
decide *how many* blocks to clear, then pay for one authoritative count to confirm —
estimate to choose, count to decide.

**Never touch the most recent few results.** The model is usually still reasoning
about them, and clearing them makes it call the same tools again — which costs more
than the pruning saved. Four is a sane default.

`maxInputTokens` is a working ceiling chosen for cost and latency, not the model's
context window. Set it well below the window so there's room for the turn that
discovers it needs more.

## 5. A verification pass

```ts
verify({ text, messages }) {
  return text.includes("```") ? { ok: true } : { ok: false, feedback: "Show the code." };
}
```

When the model would stop, the verifier gets a look. Returning `ok: false` sends the
feedback back as a user turn and the agent tries again, up to `maxVerifyAttempts`
(default 1).

The subtlety worth preserving: the verifier runs on **every** candidate answer,
including the last one. `maxVerifyAttempts` caps how many times the agent is sent
back — not whether the answer finally returned was checked. So report which:
`verified: true`, `false` (it ran out of attempts and this is the best it managed),
or `null` (no verifier configured). A caller that can't tell the difference between
"passed" and "we stopped asking" will trust the wrong answers.

## 6. Errors that carry the trace

Failures the harness raises itself extend one base class and carry the trace. API
failures stay as the SDK's own typed errors, so "the model refused" is still
distinguishable from "we were rate limited".

| Error | When |
| --- | --- |
| `RefusalError` | the model refused, with category and explanation |
| `ToolInputTruncatedError` | a turn hit the token limit mid-tool-input |
| `ContextOverflowError` | the window was exceeded, or pruning couldn't free enough |
| `MaxStepsExceededError` | the run hit its step ceiling without finishing |
| `UnparseableToolInputError` | eagerly-streamed input never parsed, after retries |

`ToolInputTruncatedError` is the one to get right. Input cut off at the token limit
usually still parses as a *valid partial object* — `{"path": "src/ind` becomes
`{"path": "src/ind"}`. There is no error to catch and nothing is malformed; the
value is just quietly wrong. The only safe move is to check the stop reason and
refuse to run the tools from that turn at all.

## 7. A trace

Every run returns an ordered list of what happened; `onEvent` streams the same
events live.

```
turn_start → turn_end(tool_use) → tool_call(read_file) → tool_result(ok, 3ms)
           → turn_start → context_pruned(6 blocks, 131k→98k)
           → turn_end(end_turn) → verify(passed)
```

Events worth emitting: `turn_start`, `turn_end`, `text_delta`, `tool_call`,
`tool_result`, `tool_denied`, `tool_invalid_input`, `tool_unknown`,
`context_pruned`, `verify`, `retry`. Attach the trace to every error too — agent
bugs are sequence bugs, and the trace is the useful half of a bug report.

---

## Confining paths and identifiers

Any path, URL or identifier that arrives from the model is untrusted output. Schema
validation says `path` is a string; it says nothing about where the string points,
and `../../.ssh/id_rsa` is a perfectly valid string.

```ts
const target = path.resolve(ROOT, candidate);
const relative = path.relative(ROOT, target);
if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  return null;
}
```

This check is lexical. If the root can contain symlinked directories, canonicalize
with `fs.realpath` as well. Put the confinement in the tool body — not the schema,
which cannot express it.

## What not to send

Verified against Anthropic's API reference on 2026-11-04. Re-check before shipping:
this is the part that stales fastest, and a stale constraint is worse than none.

- **No `temperature`, `top_p` or `top_k`** — a 400 on every model from API version
  `2026-10-21`. Not a degradation: the first request throws.
- **No forced `tool_choice`.** Both `{type: "any"}` and `{type: "tool"}` are 400 on
  Claude Opus 5.5 and Claude Sonnet 5.5, including on `count_tokens` and Batches.
  `strict: true` plus prompt-level steering replace the guarantee; structured outputs
  replace it if the forced call only existed to get JSON back. `{type: "none"}` is
  fine.
- **No thinking budget, and often no way to turn thinking off.** `effort` (inside
  `output_config`) is the depth control. On Claude Opus 5.5 thinking cannot be
  disabled at any effort level and the default is `medium`, not `high`. On Claude
  Sonnet 5.5 `{type: "disabled"}` is a 400 — `{type: "between_tools"}` is the
  off-switch, accepted only at effort `high` or below and taking no other field.
- **No assistant prefill** — a 400 on current models.
- **All parallel results in one user message.** Splitting them teaches the model to
  stop asking for parallel calls, and when the first message leaves other call ids
  unanswered it is an outright 400.
- **Retries belong to the SDK client** (`maxRetries`, default 2). Timeouts are
  themselves retried, so worst-case wall clock is `timeout × (maxRetries + 1)` — a
  second layer in the loop multiplies that again. Note the client `timeout` unit
  differs by SDK: milliseconds in TypeScript, seconds in Python and Ruby.

**`strict: true`** is a top-level field on the tool definition, not on `tool_choice`,
and it requires `additionalProperties: false` plus a correct `required` list — which
is why `defineTool` sets `additionalProperties` defensively above.

**Before hand-rolling the budget, consider not.** Two server-side mechanisms exist
and both respect the pairing rule: context editing (beta
`context-management-2025-06-27`, strategy `clear_tool_uses_20250919`, which clears
old tool results while keeping the structure valid) and compaction (beta
`compact-2026-01-12`, strategy `compact_20260112`, which summarizes — and whose
response blocks you must append in full, not just the extracted text, or the state is
silently lost). Build the budget in section 4 when you need client-side control over
what goes and when; reach for these when you don't.

**Preserved thinking makes this more than a pairing concern.** Thinking blocks are
bound to the conversation that produced them, and editing earlier turns invalidates
them — a 400 on edited history for accounts created on or after `2026-08-31`, and a
silent unbilled drop otherwise. A positional slice is an edit. This is the strongest
argument for making the harness append-only: emptying a block in place is an edit
too, so measure it on your own traffic before assuming the pruning path is free.

## When the SDK's types lag the API

Expect this, and decide deliberately rather than discovering it at the typecheck.
Fields the API accepts are sometimes absent from the installed SDK's typings, or
typed only under its beta namespace. Measured on `@anthropic-ai/sdk` 0.71.2:

| Field | Where it is in the typings |
| --- | --- |
| `strict` on a tool definition | **beta namespace only** (`resources/beta/messages`) |
| `model_context_window_exceeded` as a `StopReason` | **beta namespace only** — not in the stable union |
| `stop_details` on a `Message` | absent |
| `eager_input_streaming` on a tool | absent |

So on that version, sending `strict: true` through stable `messages.create`, or
comparing `stop_reason` against `model_context_window_exceeded`, does not typecheck
even though both are correct against the API.

Three ways out, in order of preference:

1. **Upgrade the SDK.** Check the installed version before working around anything —
   this is usually a stale dependency rather than a real gap.
2. **Use the beta path** (`client.beta.messages.*`) when you need a field that is
   typed there. That is where it is supported, not a hack.
3. **Narrow, commented casts at exactly one site each.** If you must stay on the
   stable path, put the cast in one place with a comment naming the SDK version and
   the field, so it is greppable when you upgrade:

```ts
// SDK 0.71.2 omits `stop_details` from Message; present on the wire for refusals.
const details = (message as { stop_details?: { category: string | null; explanation: string | null } }).stop_details;
```

What not to do: silently drop the field because it does not typecheck. `strict: true`
quietly omitted is the L1 guarantee gone, and a `stop_reason` comparison that can
never match is a branch that never runs. If you drop one, say so in a comment and in
whatever you hand back, so the caller knows the guarantee is not there.

## The shape the caller sees

Aim for a surface small enough to hold in your head:

```ts
const agent = new Agent({
  system: "You answer questions about this codebase. Cite the files you read.",
  tools: [readFile],
  budget: { maxInputTokens: 120_000 },
  verify: ({ text }) => /\.\w+\b/.test(text) ? { ok: true } : { ok: false, feedback: "Cite a file." },
});

const result = await agent.run("Where does request validation happen?");
// result.text, result.verified, result.usage, result.messages, result.trace
```

`run` should take a string or a full message array and return the whole conversation
back, so a caller can continue it. Give tools a per-run scratch object shared for the
length of one run and discarded after — tools that need to coordinate shouldn't have
to reach for module state, which leaks between runs and makes tests order-dependent.
