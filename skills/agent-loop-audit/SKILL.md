---
name: agent-loop-audit
description: Audits an LLM agent loop and its tool surface for the defects that survive code review and a green test suite — tool arguments trusted before validation, input truncated at max_tokens that still parses as a valid partial object, approval flags that are declared but never enforced, pruning that breaks tool_use/tool_result pairing or silently invalidates thinking blocks, side-effecting tools that report success without reading the response, and model-supplied paths used unconfined. Use this skill whenever the user asks you to review, audit, debug, harden, productionise or "look at" agent code, a tool-calling loop, a tool registry, an MCP server's tool handlers, or anything built on the Anthropic SDK, OpenAI SDK, LangChain, LangGraph or a hand-rolled agent runtime — and also when they report symptoms like a tool that ran with half an argument, an agent that repeats work after a long run, a 400 that reads like a schema complaint, a refund or email that went out twice, an agent that stopped making parallel calls, or costs that climbed without the traffic changing. Reach for it even when the user only says "is this agent code any good?" or "why did my agent do that?", since these defects are invisible in a passing test suite.
---

# Agent loop audit

An agent loop is about thirty lines: ask the model, run the tools it asks for, feed
the results back. Those thirty lines are almost never where the bugs are. The bugs
are in what the loop assumes — that arguments match the schema they were sent with,
that a parse failure throws, that a denied action should end the run, that dropping
old messages is safe, that a tool which returned a string succeeded.

Each of those assumptions is false in current APIs, and none of them fails loudly. A
loop with all five passes its tests, demos beautifully, and then transfers
`undefined` dollars in week three.

## The checklist is a floor, not a ceiling

This matters more than any individual check, so it comes first.

The checks below are the defects that are *invisible* — the ones a competent reviewer
reads past because the code looks like it handles them. They are not the full set of
things wrong with any given codebase, and they are not your audit scope. Your scope
is every production defect you can find and prove.

So: work the checks to guarantee coverage of the invisible ones, and **also read the
code as an engineer who has been paged at 3am**. A tool that posts to a billing
endpoint with no idempotency key, a handler that discards an HTTP response, a
`console.log` of a customer's PII, a knowledge-base scan that blocks the event loop —
none of those are on the list, all of them are real, and a report that omits them
because they weren't numbered is a worse report.

If you finish the checks and have found nothing else, you have not looked hard
enough at the tool bodies. That is where the money moves.

## How to run the audit

**1. Find the loop.** Look for the place that reads `stop_reason`, `tool_calls` or
`finish_reason` and dispatches on it. Search for `tool_use`, `tool_calls`,
`toolRunner`, `tool_runner`, `invoke_tool`, `execute_tool`, `AgentExecutor`. The
loop, the tool definitions and the tool bodies are usually three different files —
read all three, because most of these defects live in the seam between them.

**2. Establish the API, SDK and model.** Read `references/api-constraints.md` once
you know them. It carries the parameters that 400, the streaming flag that disables
server-side validation, the stop reasons the loop must branch on, and the supported
context-management mechanisms. Check the request against that file rather than from
memory — this is the part of the audit that stales fastest, and a confidently stated
stale constraint is worse than no constraint.

**3. Work the loop checks (L1–L9) and the tool-surface checks (T1–T7).** For each,
either name the file and line that gets it right, or report a finding. Saying "L3 is
handled at `registry.ts:71`" is as useful to the user as a finding — it proves the
audit looked, and it stops them re-deriving it next quarter.

**4. Then sweep for everything else**, with the tool bodies first.

**5. Report** in the format at the end of this file.

Only report what you can point at. Grep before you assert a negative: "declared but
never read" means you searched for every use. A defect you can't locate is a question
for the user, not a finding — put it in open questions rather than padding the list.

---

# Loop checks

## L1 — Are tool arguments validated before the tool body runs?

**Look for:** a tool handler that destructures its arguments and uses them
immediately — `const { path } = input; fs.readFileSync(path)`. No `parse`,
`safeParse`, `model_validate` or schema check between the model's output and the
first use of a value. A declared schema that is only ever converted to JSON Schema
for the wire is the tell: it looks like validation and is not.

**Why it matters:** sending a schema is not enforcing it. Two things break the
guarantee:

- With **eager input streaming** enabled, the API stops coercing and validating tool
  input. The SDK's tolerant parser then returns the best object it can build from a
  partial buffer rather than throwing — so there is no exception to catch.
- A schema describes shape, not provenance. `{"amount": 5000}` is schema-valid and
  still wrong if the gate meant to stop it ran somewhere else.

A tool that trusts its arguments runs on half an argument and reports success — the
worst available outcome, because the model is told the operation worked.

**Also check what the missing validation silently removed.** Schema defaults are
applied by the validator, not by the API, so an unvalidated optional field arrives
`undefined` and every comparison against it is false. `if (hits.length >= limit)`
with an absent `limit` never breaks the loop. Constraints go the same way:
`.positive()`, `.max(50)` and enum membership are all unenforced. Trace at least one
such field to its use and report the concrete consequence.

**The fix:** one schema, used twice — converted for the wire, and run as a validator
on what comes back:

```ts
const parsed = tool.input.safeParse(raw);
if (!parsed.ok) {
  return { content: `Invalid input for "${name}": ${parsed.issues}. Call it again with arguments matching the schema.`, isError: true };
}
await tool.run(parsed.value, ctx);   // run() never sees unvalidated input
```

Set `strict: true` on the tool definition as well (it requires
`additionalProperties: false` and a correct `required` list). The two catch different
things: `strict` constrains what the model may send, validation constrains what your
code will act on. Typed runner helpers validate for you; hand-rolled loops and
JSON-Schema tool definitions do not.

## L2 — Is a turn that hit the token limit mid-argument discarded?

**Look for:** the loop executing tool calls from a turn without first testing
`stop_reason === "max_tokens"` / `finish_reason === "length"`.

**Why it matters:** this is the one worth dwelling on, because there is nothing to
catch. Arguments cut off at the token limit usually still parse as a *valid partial
object*:

```
{"path": "src/ind      →      { "path": "src/ind" }
```

Valid JSON. Correct type. Passes the schema. Reads a file that isn't the one the
model meant, or deletes a prefix match. A `try/catch` sees nothing and a validator
sees nothing, because nothing is malformed — the value is quietly wrong.

**The fix:** check the stop reason before executing anything from that turn, and
raise it as a distinct typed failure. The calls from a truncated turn can't be
salvaged individually; the turn has to be refused whole. Note that the token limit
with *no* tool calls is a different thing — a truncated text answer — and must not be
returned as if it were complete.

## L3 — Do rejections return to the model, or end the run?

**Look for:** `throw` inside a tool body, an approval check or a validation branch,
propagating out of the loop.

**Why it matters:** a bad argument and a refused approval are both recoverable — if
the model hears about them. Returned as an error result, it corrects itself or routes
around the denial ("I can't move $5,000 myself; here's the command for you to run").
Thrown, the same information kills the run and the user gets a stack trace instead of
an answer.

| Comes back as an error result | Thrown |
| --- | --- |
| unknown tool | the model refused |
| arguments failed the schema | arguments truncated at the token limit (L2) |
| approval denied | context overflow that pruning can't fix |
| the tool body raised | the run hit its step ceiling |

The left column is the model's problem and it can fix it. The right column is the
caller's and no further turns will help. A failed call still needs a result block
with the error flag — dropping it is a 400 on the next request (L5).

**Watch the error text itself.** It is read by the model, so it should say what was
wrong and what to do — but not hand over a bypass. "refund of $250 exceeds the
automatic limit" invites three $90 refunds. "this refund requires human approval"
does not.

## L4 — Does the approval gate exist, and does it see typed values?

**Look for:** a `needsApproval` / `requires_confirmation` / `dangerous` flag on tool
definitions — then **grep for every read of it**. A declared-and-never-read flag is
the highest-value finding in this whole checklist, because it reads in code review as
if a human gate exists. Also look for gates that parse raw JSON, that run inside the
tool body after work has started, or that string-match argument text.

**Why it matters:** a gate deciding on unvalidated input is guessing — `amount` might
be `"5000"`, `5000`, `undefined` (so `undefined > 100` is false and the gate passes),
or truncated to `500` by L2. Running after validation means it reads real typed
values. A gate buried in `run()` also can't be reviewed: answering "which operations
need approval?" requires reading every tool body.

**The fix:** declare the policy per tool, beside the schema, enforced centrally
between validation and execution:

```ts
approval(input, ctx) {
  if (input.amount <= 100) return { allow: true };
  return { allow: false, reason: "transfers over $100 need a human" };
}
```

A denial is a result, not an exception (L3). And check whether the limit is enforced
anywhere that the agent process can't reason around — a client-side cap on a
money-moving operation is a speed bump, not a control. Check too whether anything
tracks *cumulative* effect across a run: a per-call cap with a step ceiling of 12
permits twelve calls.

## L5 — Does context management preserve pairing, and is it hand-rolled at all?

**Look for:** pruning that *removes* messages or blocks — `messages.slice(-10)`,
`messages.shift()`, filtering out old tool results, any sliding window over the
transcript.

**Why it matters, in three escalating ways:**

1. **Pairing.** Every tool call must be answered by a result with the matching id.
   Removing a result block, or the message holding one, breaks that and the next
   request is rejected — usually with a 400 that reads like a schema complaint and
   sends people hunting in the wrong place.
2. **Thinking blocks.** On current models, thinking blocks are bound to the
   conversation that produced them, and **editing earlier turns invalidates them**.
   For accounts created on or after `2026-08-31` this is a 400 on edited history; for
   others the blocks are dropped silently, so the agent loses its accumulated
   reasoning exactly when the task has got long and hard. A positional slice is an
   edit. See `references/api-constraints.md`.
3. **It is usually unnecessary.** There are supported server-side mechanisms for
   this — context editing, which clears old tool results while keeping the structure
   valid, and compaction, which summarizes. Both understand the pairing rule and are
   append-only by construction. Recommend them over fixing the hand-rolled version.

**If it must stay hand-rolled,** the shape is: empty the block, don't remove it.

```ts
{ ...block, content: "[earlier tool output cleared to stay within the context budget]" }
```

Plus two details — tool output is the right thing to drop first and the only thing
(the assistant turns referencing it carry the reasoning), and the most recent few
results must be exempt, because the model is still reasoning about them and clearing
them makes it call the same tools again.

**Check the threshold too.** A ceiling set far below the model's actual context
window means the destructive path runs constantly at low utilization, throwing away
history and invalidating the cache for no reason.

## L6 — Where do token counts come from, and what do they cover?

**Look for:** `tiktoken`, `gpt-tokenizer`, `len(text) / 4`,
`JSON.stringify(x).length / 4` used to decide whether a request fits.

**Why it matters:** a local tokenizer disagrees with the server and drifts between
model generations. Budgeting on it means either dropping context you didn't need to,
or sailing past the real limit into the overflow you were preventing. Check also
whether the estimate even covers the whole request — one that measures `messages` and
ignores `tools` and `system` is blind to a fixed per-request overhead.

**The fix:** count with the API's token-counting endpoint for the decision. A cheap
character estimate is still fine for picking *how many* blocks to clear before paying
for an authoritative count — estimate to choose, count to decide.

## L7 — Are model-supplied paths, URLs and identifiers confined?

**Look for:** a path, URL, hostname, table name or id that arrives in tool input and
reaches `fs`, `fetch`, a shell or a query without a containment check. `path.join`
is not a containment check.

**Why it matters:** schema validation tells you `path` is a string. It tells you
nothing about where the string points, and `../../.ssh/id_rsa` is a perfectly valid
string. This is the gap between "well-formed" and "allowed", and a schema only ever
speaks to the first.

Rank this by what the returned content reaches. In a RAG or support agent the tool
output re-enters the context and often the user-visible answer, and the model's
choice of path is influenced by documents it has already read — so one poisoned
document turns a traversal bug into credential exfiltration without the model ever
being adversarial.

**The fix:** resolve against a root and reject anything that escapes it.

```ts
const target = path.resolve(ROOT, candidate);
const relative = path.relative(ROOT, target);
if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
  return null;
}
```

Flag it as incomplete if the root can contain symlinked directories — the check is
lexical, and a symlink out of the root passes it. Canonicalize with `fs.realpath`
there. The same reasoning applies to a model-supplied URL (does it reach the metadata
service? an internal host?) and to identifiers interpolated into a query.

## L8 — Does the request send parameters the models reject, and is the cache intact?

**Look for:** `temperature`, `top_p`, `top_k`, forced tool choice, an explicit
thinking budget beside an effort setting, an assistant prefill, a second retry layer
around an SDK that already retries, and a `max_tokens` that doesn't match the
streaming mode.

**Why it matters:** several of these are hard 400s rather than ignored hints, so the
loop fails on its first request against a current model and the error rarely names
the parameter. Others are quietly expensive.

**Check prompt caching as part of this.** Agent transcripts are the ideal caching
shape — a stable tool list and system prompt, then a growing history — and a loop
with no cache breakpoint re-pays full input price for the same prefix on every step,
which on a long run is often the largest line on the bill. Look for a breakpoint at
all; then for silent invalidators: a sorted or rebuilt tool list (definitions render
first, so reordering them invalidates everything), a timestamp or request id in the
system prompt, a mid-conversation parameter change, or the destructive pruning in L5.

`references/api-constraints.md` has the verified specifics. Where forced tool choice
was doing real work, nothing restores the guarantee: strict schemas plus prompt-level
steering replace it, or structured outputs if the forced call only existed to get
JSON back.

## L9 — Is there a trace, and do stop reasons all have a home?

**Look for:** a loop whose only record is `console.log`, errors that carry a message
but no history, and a dispatch shaped `if (toolUses.length) … else return text`.

**Why the trace matters:** agent bugs are sequence bugs. "It deleted the wrong file"
is unanswerable without knowing which turn asked, what the arguments were, whether
validation passed and what the previous tool returned. Reproducing it means replaying
the whole run, and agent runs are expensive and nondeterministic. An ordered list of
turn boundaries, tool calls, results, denials, pruning and verification outcomes —
attached to the error that ends the run — is the useful half of a bug report and
costs almost nothing to carry.

**Why the two-branch shape matters:** it silently treats every stop reason that isn't
a tool call as a finished answer. A refusal returns empty text to the user. A paused
turn returns a partial answer and never resumes. A truncated answer returns as
complete. Each needs its own branch — see the stop-reason table in
`references/api-constraints.md`.

**Also check** that parallel results are returned in a single user message. Splitting
them across messages teaches the model to stop asking for parallel calls, which
surfaces as an agent that got slower for no visible reason — and when the first
message answers only one call id, leaving the rest unanswered, it is an outright 400.

---

# Tool-surface checks

The loop is where reviewers look. The tool bodies are where the money is. Read every
tool that has a side effect — writes, payments, messages, tickets, deletions — with
these in mind.

## T1 — Does the tool check the response before reporting success?

A handler that fires a request and discards the result, then returns `"escalated"` or
`"sent"`, reports success for a 500. The model relays that to the user, who is told a
human will follow up. Nobody will. Look for a discarded response, a `status === 200`
comparison narrow enough to treat `201`/`202` as failure, and a failure path that
returns a string rather than setting the error flag — a tool that returns
`"refund failed"` with no error flag reads to the model as a normal result.

## T2 — Are side-effecting calls idempotent under retry?

The SDK retries, the model retries after an error, and a timeout can fire after the
operation committed. Without an idempotency key derived from something stable for the
call (the tool-use id works), a slow-but-successful payment reported as an error
becomes a second payment. Check for a key, a timeout, and whether the reported
failure is distinguishable from an unknown outcome.

## T3 — Is the result bounded, and never empty?

An unbounded tool result — a whole file, an unlimited search — can consume a large
fraction of the context in one block, and a deliberately large input is a cheap
denial-of-wallet. Cap it and say in the content that it was truncated, so the model
knows it is working from a fragment. At the other end, guard the empty string: an
empty result is at best uninformative to the model and may be rejected outright. A
central guard in the executor covers every present and future tool.

## T4 — Is a terminal tool actually terminal?

A tool that hands off — escalate, transfer, close — is semantically the end of the
run, but if its result is an ordinary string the loop continues and the model may call
it again, filing a duplicate. Check whether anything marks it terminal.

## T5 — Are parallel calls executed concurrently?

A `for … await` over the calls from one turn serializes work the model asked to
overlap. Correct is concurrent execution, results collected in original order, and
one user message (L9).

## T6 — What goes into the logs?

Tool inputs are the richest PII in an agent: customer ids, amounts, free-text
reasons, whatever the model copied from the conversation into a query. A
`JSON.stringify(input)` log line sends all of it wherever stdout aggregates, usually
with broader access and longer retention than the systems the data came from. Check
for secrets too — tokens or keys passed through tool input or echoed in errors.

## T7 — Does the tool block the event loop or depend on ambient state?

Synchronous file and directory reads inside an `async` handler block everything else
in the process. Paths resolved from the current working directory make the tool
depend on how the process was started, and present as "the agent has no knowledge
base" rather than as a configuration error. Neither is exotic; both are common in
handlers written quickly.

---

# Report format

Lead with what's exploitable. Someone skimming the first three lines should learn
whether they have a problem today.

```markdown
# Agent loop audit — <project>

**Loop:** <file:line of the dispatch>  ·  **SDK:** <name + version>  ·  **Model:** <id>  ·  **Tools:** <count>

## Summary
<Two to four sentences. The most serious defect and what triggers it. If the service
cannot work at all as written, say that first and say why.>

## Critical
### 1. <What goes wrong, stated as an outcome> — `file.ts:120`
**What happens:** <the concrete sequence: this input → this behaviour>
**Trigger:** <the input or condition that reaches it>
**Fix:**
```<lang>
<the diff or replacement>
```

## High
## Medium
## Low

## Verified
- L3 rejections return as error results — `registry.ts:148`
- L5 pruning empties blocks rather than removing them — `budget.ts:171`

## Suggested fix order
<Ordered, with the reasoning. Note where one fix subsumes others.>

## Open questions
<What needs the user to answer before it can be called a defect.>
```

Group by severity, and order within a group by what an unlucky input reaches first —
not by check number. Severity is about consequence and reachability together: a
guaranteed 400 on every request outranks a traversal bug that needs a crafted path,
which outranks a cost defect.

Cite a file and line for every finding, state the triggering condition, and give the
fix as code where the fix is code. A finding without a trigger is a code smell, and
labelling it critical spends credibility you'll want for the real ones.

If a check passes, put it in Verified. If everything passes, say so plainly — a clean
audit is a useful result, and inventing a finding to justify the exercise makes the
next audit worthless.
