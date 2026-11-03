# API constraints that change the audit

**Verified against Anthropic's current API reference on 2026-11-04.** This is the
fastest-staling part of the audit. When something here contradicts the provider's
current documentation, the documentation wins, and the finding should say which you
checked against. Re-verify before asserting a 400 to a user.

## Contents

- [Claude / Anthropic API](#claude--anthropic-api)
  - [Parameters that return 400](#parameters-that-return-400)
  - [Thinking and effort, per model](#thinking-and-effort-per-model)
  - [Validation and eager input streaming](#validation-and-eager-input-streaming)
  - [Stop reasons the loop must branch on](#stop-reasons-the-loop-must-branch-on)
  - [Message shape rules](#message-shape-rules)
  - [Context management: the supported mechanisms](#context-management-the-supported-mechanisms)
  - [Preserved thinking](#preserved-thinking)
  - [Prompt caching](#prompt-caching)
  - [max_tokens, timeouts and retries](#max_tokens-timeouts-and-retries)
  - [Unverified](#unverified)
- [Other providers](#other-providers)
- [Framework-specific notes](#framework-specific-notes)

---

## Claude / Anthropic API

### Parameters that return 400

| Parameter | Status |
| --- | --- |
| `temperature`, `top_p`, `top_k` | **400 on every model** for requests on API version `2026-10-21` or later |
| `tool_choice: {type: "any"}` | 400 on Claude Opus 5.5, Claude Sonnet 5.5, Claude Fable 5.1, Claude Mythos 5.1 |
| `tool_choice: {type: "tool", name}` | 400 on the same models — including on `count_tokens` and the Batches API |
| `thinking.budget_tokens` | removed on current models; `effort` replaces it |
| assistant prefill (last turn `assistant`) | 400 on current models |

`tool_choice: {type: "none"}` is unaffected, and `disable_parallel_tool_use` still
works alongside `auto`.

Two consequences for the audit:

- **Forced tool choice is not available as a guarantee.** Code relying on
  `tool_choice: {type: "tool"}` to be certain a tool was called has no direct
  replacement. What's left: `auto` plus an explicit prompt instruction naming the
  tool, `strict: true` to keep arguments schema-valid, or structured outputs
  (`output_config.format`) when the forced call only existed to get JSON back.
- **A loop that still sends `temperature` is down, not degraded.** It throws on the
  first request. Rank it accordingly.

`strict: true` is a top-level field on the tool definition, not on `tool_choice`, and
it requires `additionalProperties: false` plus a correct `required` list in the
schema. A tool definition that sets neither has no guarantee at either layer.

### Thinking and effort, per model

`effort` lives inside `output_config`, not at the top level:
`output_config: {effort: "low"|"medium"|"high"|"xhigh"|"max"}`.

| Model | Turning thinking off | Effort default |
| --- | --- | --- |
| Claude Opus 5.5 | not possible — `{type: "disabled"}` and `budget_tokens` are 400 at **every** effort level | **`medium`** |
| Claude Sonnet 5.5 | `{type: "disabled"}` is 400; send `{type: "between_tools"}`, accepted only at effort `high` or below, and it takes no other field | `high`, levels recalibrated |
| Claude Haiku 5.5 | `disabled` only at `high` or below | `medium` |
| Claude Fable 5.1 | not possible — omit `thinking` | — |

A loop that assumes it can disable thinking, or that it gets `high` by default on
Opus 5.5, is budgeting wrong. Flag an inherited disabled-thinking setting: on these
models it is a 400, and on the models where it is accepted it has its own failure
modes (the model occasionally writes a tool call into visible text instead of a
`tool_use` block, where it never runs and raises nothing).

Thinking display defaults to `"omitted"` on current models — thinking happens and is
billed, but the text is empty. Code that expected to show reasoning and shows a long
pause instead needs `display: "summarized"` set explicitly.

### Validation and eager input streaming

This is the mechanism behind check L1, and it is worth understanding rather than
taking on faith:

- Tools sent with `strict: true` are validated server-side.
- **`eager_input_streaming: true` turns that off.** Input streams before it is
  complete, so the API no longer coerces or validates it, and the accumulated partial
  JSON may be incomplete (at the token limit) or invalid.
- The SDKs' parsers for it are deliberately tolerant: they return the best object
  they can build rather than raising.

So eager streaming plus a trusting tool body produces a silently truncated argument
with no error anywhere in the path. Where it is on, client-side validation is not
defence in depth — it is the only validation present.

Who validates:

| Path | Validates tool input? |
| --- | --- |
| typed runner helpers (`betaZodTool`, typed `@beta_tool`) | yes |
| JSON-Schema tool definitions (`betaTool()`) | no — you must |
| hand-rolled loop | no — you must |

It needs no beta header and no `client.beta.*` path; a request also sending the
legacy `fine-grained-tool-streaming-2025-05-14` header is misconfigured. Check whether
it is set per-tool or globally, and whether a streaming code path enables it
implicitly — a loop that validates on the blocking path and skips it on the streaming
path has the defect only in production.

### Stop reasons the loop must branch on

| `stop_reason` | What the loop should do |
| --- | --- |
| `tool_use` | validate, gate, execute concurrently, return all results in one user message |
| `end_turn` | the candidate answer — verify it if there's a verifier |
| `max_tokens` | if tool calls are present, **discard them** (L2) and raise; if not, it's a truncated answer — never return it as complete |
| `refusal` | raise or route to a human; read `stop_details` |
| `pause_turn` | append the turn and re-send to resume — not an error, not the end |
| `model_context_window_exceeded` | prune and retry, or raise if pruning can't free enough |

`stop_details` is populated **only** when `stop_reason` is `"refusal"` and is `null`
for every other stop reason, so a loop that reads it unguarded will throw on a normal
turn. Its `category` is an open set (`cyber`, `bio`, `reasoning_extraction`,
`frontier_llm`, `general_harms`, or null).

A refusal arrives as **HTTP 200** with no tool calls and typically no text, so an
`if (toolUses.length) … else return text` shape returns an empty string to the user,
and a false-positive refusal on an ordinary request is indistinguishable from
success. Server-side fallbacks can reroute instead: `betas:
["server-side-fallback-2026-07-01"]` with `fallbacks: "default"` routes by refusal
category. (The older array form uses `server-side-fallback-2026-06-01` with
`fallbacks: [{model: ...}]`; pairing either header with the other form is a 400. On
Claude Sonnet 5.5 only the `"default"` form, and only on the Claude API. Not
available on Bedrock, Vertex or Foundry — those use the SDKs' client-side refusal
fallback middleware.)

### Message shape rules

- **Every `tool_use` needs a `tool_result` with the matching id.** This is what L5
  protects. Removing either side is a 400.
- **All results from one turn go in a single user message.** Splitting them across
  messages is what L9 checks: when the first message answers only one call id and
  leaves the rest unanswered, the next request is malformed; and even where it isn't,
  it trains the model to stop making parallel calls.
- **A failed call still needs a result block** with `is_error: true`. Don't drop it.
- Parallel tool use is on by default, so a loop that has never seen two calls in one
  turn has not been tested, not proven safe.

### Context management: the supported mechanisms

Hand-rolled pruning is usually the wrong answer. Two server-side mechanisms exist and
both respect the pairing rule:

**Context editing** — clears old content, does not summarize. On
`client.beta.messages.*` with beta `context-management-2025-06-27`:

```
context_management: { edits: [{ type: "clear_tool_uses_20250919" }] }
```

Strategies: `clear_tool_uses_20250919` (clears old tool results; optional
`clear_tool_inputs: true` also clears the `tool_use` params) and
`clear_thinking_20251015`.

**Compaction** — summarizes earlier context server-side when it approaches a
threshold. Beta `compact-2026-01-12`, strategy `compact_20260112`. The critical
caveat for an audit: the response carries a compaction block, and the caller must
append `response.content` — not just the extracted text — or the compaction state is
silently lost on the next request. Code that appends only the text string has a
latent bug.

These are different features; `compact_20260112` is not a context-editing strategy
and `clear_tool_uses_*` is not compaction. Recommending the right one matters.

### Preserved thinking

Thinking blocks are bound both to the model that produced them and to the
conversation that produced them. **Editing earlier turns invalidates them.**

- Accounts created on or after `2026-08-31`: a **400 on edited history**, on every
  platform.
- Other accounts: the blocks are dropped silently and unbilled — so the agent loses
  accumulated reasoning with no error to notice.

A positional slice, a filtered message list, a deleted per-turn reminder and an
in-place rewrite are all edits. This is the second reason L5's hand-rolled pruning is
a defect rather than a style choice, and the reason to call a harness append-only as
the fix rather than "trim more carefully".

Pass thinking blocks back unchanged on every request, including after a model switch —
the API drops, unbilled, any block the current model can't read, so stripping them
client-side only removes reasoning the model could have used.

### Prompt caching

Caching is a prefix match: any byte change anywhere in the prefix invalidates
everything after it. Render order is **`tools` → `system` → `messages`**.

- Maximum 4 breakpoints per request.
- The minimum cacheable prefix is model-dependent (roughly 512–4096 tokens); shorter
  prefixes silently don't cache.
- Verify with `usage.cache_read_input_tokens`. Zero across repeated requests with a
  supposedly identical prefix means a silent invalidator.

For an agent loop, the audit-relevant invalidators are: a sorted or rebuilt tool list
(definitions render first, so reordering invalidates everything after), a timestamp or
request id in the system prompt, a mid-conversation top-level parameter change, and
destructive history pruning (L5). A loop with no breakpoint at all re-pays full input
price for the same prefix every step — usually the largest single line on the bill for
a long-running agent, and a cost finding worth reporting even though nothing breaks.

### max_tokens, timeouts and retries

- Current models support up to **128K** output tokens, but the SDKs require streaming
  for values that large to avoid HTTP timeouts.
- Sensible defaults: **~16000 non-streaming** (keeps responses under the SDK HTTP
  timeout), **~64000 streaming**. One value used for both either wastes the streaming
  headroom or risks the blocking timeout. Lowballing it truncates mid-answer and
  wastes the whole step.
- Client `timeout` defaults to 10 minutes, and **the units differ by SDK** —
  milliseconds in TypeScript, seconds in Python and Ruby. A `timeout: 30` meant as
  thirty seconds is thirty milliseconds in TypeScript.
- `maxRetries` defaults to 2 and covers 408/409/429/5xx plus connection errors.
  **Timeouts are themselves retried**, so worst-case wall clock is
  `timeout × (maxRetries + 1)` — a default-configured client can sit for ~30 minutes
  on one step with no progress signal. A second retry layer in the loop multiplies
  that again.
- Error handling should be a most-specific-first chain (`NotFoundError` →
  `RateLimitError` → `APIStatusError` → `APIConnectionError`), because one broad
  catch loses the retryable/non-retryable distinction that decides what to do next.

Context windows are 1M on current models. Don't hard-code a window — the Models API
exposes `max_input_tokens` and `max_tokens` per model (there is no `context_window`
field). A budget ceiling set to 150K against a 1M window means the pruning path runs
at 15% utilization.

### Unverified

**Empty text content blocks.** A tool returning `""` producing an empty
`tool_result`, and that being rejected outright, is plausible and was reported in
testing but is **not confirmed** in the reference. Report an unguarded empty result
as a robustness defect — uninformative to the model at best — rather than asserting a
400, unless you can confirm it against current documentation.

---

## Other providers

The checks are about behaviour, so they transfer. Confirm these against current docs:

**OpenAI SDK.** Whether strict function schemas are enforced on the path in use, and
whether streaming changes it. L2 maps to `finish_reason === "length"`, with the same
reasoning: arguments cut mid-stream can deserialize cleanly. Pairing (L5) maps to
`tool_call_id` on each tool message; parallel calls arrive as several entries in one
assistant message and each needs its own reply message.

**Any provider.** Provider-independent, and where most real defects sit: L1, L2, L3,
L4, L7, L9 and all of T1–T7. Audit those from the code alone.

---

## Framework-specific notes

**LangChain / LangGraph.** Argument validation depends on how the tool was declared —
a decorated function with type hints is not the same guarantee as a Pydantic args
schema, and a plain-string tool has none. Check what the decorator produced rather
than assuming the annotation is enforced. Pruning is usually a message-history
reducer; verify it keeps tool-call/tool-message pairs together, since node-level
trimming is where pairing most often breaks.

**SDK tool runners** (`client.beta.messages.toolRunner` with `betaZodTool`;
`client.beta.messages.tool_runner` with `@beta_tool`). These drive the loop correctly
and validate typed tool inputs, which disposes of L1, L2, L3, L5 and L9 as loop-shape
findings. What remains is entirely the tool bodies: L4, L7 and all of T1–T7. A runner
handles the sequence, not the trust boundary — audit the bodies as carefully as a
hand-rolled loop, and note in the report that the loop itself is maintained upstream.

Per-turn hooks are the right home for an approval gate under a runner, so "move the
gate into a hook" is usually a better recommendation than "add a gate inside `run()`".

**Worth saying in the report** when the loop is hand-rolled and most findings are
loop-shape: the SDK tool runner implements single-message result batching,
pairing-safe history, iteration caps, per-turn hooks for approval and input
validation. Porting removes the class of defect rather than patching instances. Say
it once, as a closing recommendation — not as a finding.
