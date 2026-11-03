# The loop

Read this at step 6, once the registry, budget and errors exist. The loop is the
smallest file in the harness and the one with the most decisions per line.

## Contents

- [Shape](#shape)
- [Branching on the stop reason](#branching-on-the-stop-reason)
- [Running tools](#running-tools)
- [The verification send-back](#the-verification-send-back)
- [Request construction](#request-construction)
- [Retrying unparseable tool input](#retrying-unparseable-tool-input)
- [Cancellation and per-run state](#cancellation-and-per-run-state)

## Shape

```
for step in 1..maxSteps:
    fit the request to the budget        # measure, prune, measure
    send                                 # blocking or streaming
    branch on stop_reason:
        refusal                     -> throw RefusalError
        context window exceeded     -> throw ContextOverflowError
        pause_turn                  -> append assistant turn, continue
        max_tokens with tool calls  -> throw ToolInputTruncatedError
        no tool calls               -> verify, then return or send back
        tool calls                  -> execute concurrently, append ONE user message
throw MaxStepsExceededError
```

Everything after the `send` is a branch on one field. Writing it as a flat sequence
of guards, in this order, keeps each failure mode visible — a nested
`if (toolUses.length)` with the terminal reasons handled inside it is where
`pause_turn` and `max_tokens` get silently treated as a finished answer.

## Branching on the stop reason

The order matters, because some of these overlap.

**`refusal` first.** It carries a category and an explanation worth surfacing to the
caller rather than flattening into a generic error.

**Context overflow next.** The request was too large despite pruning. Raising here
rather than retrying prevents a loop that prunes, fails, prunes, fails.

**`pause_turn` before anything that inspects content.** A server-side tool hit its
iteration limit; the turn is incomplete, not finished. Append the assistant turn and
re-send to let it continue. Treating this as `end_turn` truncates long runs in a way
that looks like the model giving up, and it's the single most common loop bug in
code that was written against a two-branch example.

**`max_tokens` with tool calls present → throw.** This guard has to come *before*
the tool-execution path, and it's the one that justifies a dedicated error type:

```ts
if (message.stop_reason === "max_tokens" && toolUses.length > 0) {
  throw new ToolInputTruncatedError(toolUses.map((u) => u.name), trace);
}
```

Input cut off at the token limit usually still parses as a valid partial object —
`{"path": "src/ind` becomes `{"path": "src/ind"}`. Nothing is malformed, so no
parser and no schema will object. Checking the stop reason is the only signal there
is, and the calls from that turn cannot be salvaged individually.

Note that `max_tokens` with *no* tool calls is different: that's a truncated text
answer, which is the caller's to judge. Let it fall through to the normal path and
report the stop reason in the result.

## Running tools

Two things to get right:

**Concurrency.** Run the calls from one turn concurrently — they were requested
together and are usually independent.

**One user message for all results.** Collect every result and push a single user
message containing all of them. Splitting them across messages is accepted by the
API but teaches the model to stop asking for parallel calls, which shows up weeks
later as an agent that got slower for no visible reason.

```ts
messages.push({ role: "assistant", content: message.content });

const results = await Promise.all(
  toolUses.map(async (use) => {
    emit({ type: "tool_call", step, id: use.id, name: use.name, input: use.input });
    const outcome = await registry.execute(use.name, use.input, { step, signal, state });
    // emit tool_unknown / tool_invalid_input / tool_denied from outcome.rejection
    emit({ type: "tool_result", step, id: use.id, name: use.name, ok: !outcome.isError, durationMs: outcome.durationMs });
    return {
      type: "tool_result" as const,
      tool_use_id: use.id,
      content: outcome.content,
      ...(outcome.isError ? { is_error: true } : {}),
    };
  }),
);

messages.push({ role: "user", content: results });
```

Push the assistant turn *before* executing, not after. If a tool throws something
the registry doesn't catch, the transcript still shows what the model asked for, and
the trace is still coherent.

Every call gets a result block, including unknown tools, schema failures and
denials — with `is_error: true`. A missing result block for a `tool_use` id is a 400
on the next request, so there is no "skip it" option even when the call was nonsense.

## The verification send-back

When no tool calls came back, the model is offering an answer:

```ts
const candidate = { role: "assistant", content: message.content };
const outcome = await verify({ text, messages: [...messages, candidate] });
emit({ type: "verify", step, passed: outcome.ok, ...(outcome.ok ? {} : { feedback: outcome.feedback }) });

if (!outcome.ok && verifyAttempts < maxVerifyAttempts) {
  verifyAttempts++;
  messages.push(candidate);
  messages.push({ role: "user", content: outcome.feedback });
  continue;              // another pass
}
// otherwise fall through and return with `verified: outcome.ok`
```

Two details that are easy to lose:

- **The candidate is included in what the verifier sees** (`[...messages, candidate]`),
  so a verifier can check the answer against the conversation that produced it.
- **The verifier runs on every candidate, including the final one.** When attempts
  run out, return `verified: false` rather than throwing or silently returning
  `true`. The caller needs to distinguish "passed" from "we stopped asking" — those
  are different levels of trust, and collapsing them is how an unverified answer
  ends up in production.

Pass `verified: null` when no verifier was configured, so "no opinion" isn't
confused with "failed".

## Request construction

```ts
const params = {
  model,
  max_tokens: maxTokens,
  messages: [...messages],     // a snapshot, not the live array
};
if (system) params.system = system;
if (tools.length > 0) params.tools = tools;
if (effort) params.output_config = { effort };
if (thinkingDisplay) params.thinking = { type: "adaptive", display: thinkingDisplay };
```

**Snapshot the messages.** The loop keeps pushing to `messages`, and handing that
same reference to the client means anything holding the request body — an
interceptor, a log line, a test assertion — sees it mutate underneath. This costs
one array copy per turn and removes a whole category of confusing bug.

**Omit rather than send empty.** No `tools` key when there are no tools, no `system`
when there's no system prompt. Sending empty values is accepted in some cases and a
400 in others, and omitting is never wrong.

**`max_tokens` differs by mode** — roughly 16k blocking, 64k streaming. The blocking
ceiling is about staying under the SDK's HTTP timeout; once streaming, timeouts stop
being the constraint. One value for both wastes the streaming headroom.

## Retrying unparseable tool input

With eager input streaming the server stops validating tool input, so the stream's
final-message assembly can reject when nothing parseable arrived. That specific
failure is worth one more attempt; a real API error is not:

```ts
try {
  message = await send(...);
  jsonReissues = 0;
} catch (error) {
  if (error instanceof Anthropic.APIError || jsonReissues >= MAX_JSON_REISSUES) throw error;
  jsonReissues++;
  emit({ type: "retry", step, reason: "tool input was not parseable JSON" });
  continue;
}
```

Reset the counter on success, so a long run isn't killed by two unrelated hiccups
twenty turns apart. Cap the re-issues (two is enough) and let the typed error out
after that — an infinite re-ask against a model that keeps producing the same
garbage is worse than a clear failure.

Note this retry is for malformed *transport*, not for schema failures. A schema
failure is a result the model can fix (the registry's job), not a re-send.

## Cancellation and per-run state

Thread the caller's `AbortSignal` into both the API request and the tool context, so
a cancelled run stops the in-flight request *and* lets long-running tools bail out.
A signal that only reaches the HTTP layer leaves tools running after the caller gave
up.

Give each run a scratch object shared by every tool for the length of that run and
discarded after. Tools that need to coordinate — a cache, a transaction handle, a
count — shouldn't reach for module-level state, which leaks between runs and makes
tests order-dependent. Let the caller seed it, which makes a tool's dependencies
injectable in tests.
