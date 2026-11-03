# Testing an agent loop without a network

Read this before writing the first component. A fake client is the difference
between a suite that covers the failure paths and one that covers the happy path
and hopes.

Agent runs are expensive, slow and nondeterministic, so testing against a live model
tests the model rather than the loop. Everything worth asserting about a harness —
parallel calls, refusals, truncation, pruning, verification send-backs, state
isolation — is reachable by replaying scripted responses through a stand-in client.
None of it needs a key, and a full suite runs in under a second.

## The fake client

Script the responses, record the requests:

```ts
export function fakeClient(
  script: Anthropic.Message[],
  options: { tokenCounter?: (p: Anthropic.MessageCountTokensParams) => number } = {},
) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const tokenCounts: Anthropic.MessageCountTokensParams[] = [];
  let index = 0;

  const client = {
    messages: {
      async create(params) {
        requests.push(params);
        const next = script[index++];
        if (!next) throw new Error(`fake client: script exhausted at call ${index}`);
        return next;
      },
      async countTokens(params) {
        tokenCounts.push(params);
        return { input_tokens: options.tokenCounter?.(params) ?? 0 };
      },
    },
  };

  return { client: client as unknown as Anthropic, requests, tokenCounts };
}
```

Three things earn their keep here:

**Recording the requests is half the value.** Most of what you want to assert is
about what the harness *sent*: did the tool results arrive in one message, did the
tool order stay stable, was the pruned placeholder actually in the body, was
`temperature` absent. The response script drives the run; the recorded requests are
what you assert on.

**Failing loudly when the script runs out.** `script exhausted at call 4` tells you
the loop took a turn you didn't predict, which is usually the bug. Returning a
default `end_turn` instead would hide it.

**An injectable token counter.** The budget's behaviour is entirely a function of
what the counter returns, so a counter you control makes pruning testable
deterministically — return 200k on the first call and 90k after, and assert that the
placeholder appeared and the second count happened.

## Fixtures

The SDK's `Message` has a long tail of nullable metadata no test asserts on. A
builder with a cast keeps fixtures readable:

```ts
export function message(partial: {
  content?: Anthropic.ContentBlock[];
  stop_reason?: Anthropic.StopReason;
  stop_details?: { type: "refusal"; category: string | null; explanation: string | null };
  usage?: Partial<Anthropic.Usage>;
}): Anthropic.Message {
  return {
    id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5",
    content: partial.content ?? [],
    stop_reason: partial.stop_reason ?? "end_turn",
    stop_sequence: null,
    stop_details: partial.stop_details ?? null,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null, ...partial.usage },
  } as unknown as Anthropic.Message;
}

export const textBlock = (text: string) => ({ type: "text", text, citations: null }) as unknown as Anthropic.ContentBlock;
export const toolUseBlock = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as unknown as Anthropic.ContentBlock;
```

The cast is deliberate and worth a comment in the code. Fully constructing the SDK's
type in every fixture makes tests unreadable, and the fields being omitted are ones
no assertion touches.

One extraction helper is worth writing, because `MessageParam` is a union whose
members type `content` differently — a type predicate passed straight to `.filter`
resolves against the union and loses its narrowing. Widen to a single block array
first:

```ts
export function toolResultsIn(message: Anthropic.MessageParam | undefined): Anthropic.ToolResultBlockParam[] {
  if (!message || !Array.isArray(message.content)) return [];
  const blocks = message.content as Anthropic.ContentBlockParam[];
  return blocks.filter((b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result");
}
```

## What to cover

The failure paths, in rough order of how much they'd cost in production:

| Case | Script | Assert |
| --- | --- | --- |
| Arguments miss the schema | `tool_use` with a bad input | the tool body never ran; the result has the error flag and names the issue |
| Truncated tool input | `stop_reason: "max_tokens"` + a `tool_use` block | `ToolInputTruncatedError`, and **no tool ran** |
| Approval denied | `tool_use` whose gate refuses | result carries the reason; the run continues; the model gets another turn |
| Unknown tool | `tool_use` with a name not in the registry | error result lists the available tools; no throw |
| Tool body throws | a tool whose `run` rejects | error result, run continues |
| Parallel calls | two `tool_use` blocks in one message | **one** user message with two result blocks, ids matching |
| Pruning | counter returns over budget, then under | oldest result emptied to the placeholder, recent ones untouched, pairing intact |
| Pruning can't help | over budget with nothing eligible | `ContextOverflowError`, not an infinite prune loop |
| Verification send-back | `end_turn` that fails `verify`, then one that passes | feedback appended as a user turn; `verified: true` |
| Verification exhausted | every candidate fails | returns with `verified: false`, does not throw |
| Refusal | `stop_reason: "refusal"` with details | `RefusalError` carrying category and explanation |
| `pause_turn` | a paused turn, then a normal one | the turn was re-sent, not treated as the answer |
| Step ceiling | more tool calls than `maxSteps` | `MaxStepsExceededError` with the trace attached |
| State isolation | two runs with the same agent | the second run sees a fresh scratch object |

For the request-shape invariants, assert on the recorded requests rather than the
result: tool order unchanged across turns, no `temperature` / `top_p` / `top_k`, no
forced tool choice, `tools` omitted when there are none, and the messages array in
one request not mutated by later turns.

## Asserting on the trace

The trace is a test surface, not just a debugging aid. It makes assertions about
*sequence* readable in a way that inspecting messages isn't:

```ts
expect(trace.map((e) => e.type)).toEqual([
  "turn_start", "turn_end", "tool_call", "tool_result",
  "turn_start", "context_pruned", "turn_end", "verify",
]);
```

That one assertion catches a pruning pass that ran at the wrong time, a verifier
that never ran, and a tool that was called twice. Checking the same thing against
message contents takes a dozen lines and reads like nothing.

Assert on the specific events too — `context_pruned` carrying plausible before/after
counts, `tool_denied` carrying the gate's reason — since an event that fires with
empty fields is a bug the type system won't catch.

## A demo that costs nothing

Worth building alongside the suite: a scripted run that walks the harness into each
failure on purpose — a schema rejection, an approval denial, a pruning pass, a
verification send-back — with no key and no spend. The loop, the validation, the
gate, the budget and the verifier are all real; only the model is scripted.

It doubles as the thing you show someone. A harness earns its keep on the turns that
go wrong, so a demo of the happy path demonstrates nothing.
