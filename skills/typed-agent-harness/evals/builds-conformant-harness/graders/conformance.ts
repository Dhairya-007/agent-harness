// Executable conformance suite for the agent-harness brief.
// Judges either arm through the contracted public surface only.
// Usage: npx tsx conformance.ts <armDir>
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const armDir = process.argv[2];
if (!armDir) throw new Error("usage: conformance.ts <armDir>");
const mod = await import(`${armDir}/src/index.ts`);
const { Agent, defineTool } = mod as any;

// ---------- fake client ----------
type Req = any;
function fakeClient(script: any[], tokenCounter?: (p: any) => number) {
  const requests: Req[] = [];
  const counts: any[] = [];
  let i = 0;
  const next = (params: Req) => {
    requests.push(JSON.parse(JSON.stringify(params)));
    const m = script[i++];
    if (!m) throw new Error(`script exhausted at call ${i}`);
    return m;
  };
  const client: any = {
    messages: {
      async create(params: Req) { return next(params); },
      stream(params: Req) {
        const m = next(params);
        return { on() { return this; }, async finalMessage() { return m; }, async done() {} };
      },
      async countTokens(params: Req) { counts.push(params); return { input_tokens: tokenCounter ? tokenCounter(params) : 0 }; },
    },
  };
  return { client, requests, counts, calls: () => i };
}
const msg = (p: any): any => ({
  id: "msg_t", type: "message", role: "assistant", model: "claude-opus-5-5",
  content: p.content ?? [], stop_reason: p.stop_reason ?? "end_turn",
  stop_sequence: null, stop_details: p.stop_details ?? null,
  usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null, ...(p.usage ?? {}) },
});
const text = (t: string): any => ({ type: "text", text: t, citations: null });
const toolUse = (id: string, name: string, input: unknown): any => ({ type: "tool_use", id, name, input });

// ---------- assertions ----------
type Res = { id: string; name: string; passed: boolean; detail: string };
const results: Res[] = [];
async function check(id: string, name: string, fn: () => Promise<string>) {
  try { results.push({ id, name, passed: true, detail: await fn() }); }
  catch (e) { results.push({ id, name, passed: false, detail: (e as Error).message }); }
}
function eq(a: unknown, b: unknown, what: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function ok(c: boolean, what: string) { if (!c) throw new Error(what); }
const resultsIn = (m: any): any[] => Array.isArray(m?.content) ? m.content.filter((b: any) => b.type === "tool_result") : [];
const lastMsg = (r: Req) => r.messages[r.messages.length - 1];

function pairingIntact(messages: any[]): boolean {
  const uses = new Set<string>(), res = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use") uses.add(b.id);
      if (b.type === "tool_result") res.add(b.tool_use_id);
    }
  }
  return uses.size === res.size && [...uses].every((u) => res.has(u));
}

// ---------- C1: validation happens before the tool body ----------
await check("C1", "invalid arguments never reach the tool body", async () => {
  let ran = 0;
  const t = defineTool({ name: "read", description: "Reads a file.", input: z.object({ path: z.string() }), run: () => { ran++; return "x"; } });
  const f = fakeClient([msg({ stop_reason: "tool_use", content: [toolUse("u1", "read", { path: 123 })] }), msg({ content: [text("done")] })]);
  const a = new Agent({ client: f.client, tools: [t] });
  await a.run("go");
  eq(ran, 0, "tool body invocations");
  const rs = resultsIn(lastMsg(f.requests[1]));
  eq(rs.length, 1, "result blocks");
  ok(rs[0].is_error === true, "result must be flagged is_error");
  return `run() not called; error result returned: ${String(rs[0].content).slice(0, 70)}`;
});

// ---------- C2: a max_tokens turn's tool calls are discarded ----------
await check("C2", "tool calls from a max_tokens turn do not execute", async () => {
  let ran = 0;
  const t = defineTool({ name: "pay", description: "Pays.", input: z.object({ amount: z.number() }), run: () => { ran++; return "paid"; } });
  const f = fakeClient([msg({ stop_reason: "max_tokens", content: [toolUse("u1", "pay", { amount: 50 })] })]);
  const a = new Agent({ client: f.client, tools: [t] });
  let threw = false;
  try { await a.run("go"); } catch { threw = true; }
  eq(ran, 0, "tool body invocations");
  ok(threw, "must raise rather than return a truncated turn as an answer");
  return "raised, and run() was not called";
});

// ---------- C3: denial returns to the model, run continues ----------
await check("C3", "an approval denial returns as an error result, not an exception", async () => {
  let ran = 0;
  const t = defineTool({
    name: "refund", description: "Refunds.", input: z.object({ amount: z.number().positive() }),
    approval: (i: any) => (i.amount <= 100 ? { allow: true } : { allow: false, reason: "over $100 needs a human" }),
    run: () => { ran++; return "refunded"; },
  });
  const f = fakeClient([msg({ stop_reason: "tool_use", content: [toolUse("u1", "refund", { amount: 250 })] }), msg({ content: [text("I cannot do that")] })]);
  const a = new Agent({ client: f.client, tools: [t] });
  const r = await a.run("refund 250");
  eq(ran, 0, "tool body invocations");
  const rs = resultsIn(lastMsg(f.requests[1]));
  ok(rs[0]?.is_error === true, "denial must be an error result");
  ok(String(rs[0].content).includes("human"), "denial reason must reach the model");
  ok(r.text.length > 0, "run must complete");
  return "denied, model got the reason and another turn";
});

// ---------- C4: approval allows the small case ----------
await check("C4", "an allowed call runs with typed values", async () => {
  let got: any = null;
  const t = defineTool({
    name: "refund", description: "Refunds.", input: z.object({ amount: z.number().positive() }),
    approval: (i: any) => (i.amount <= 100 ? { allow: true } : { allow: false, reason: "no" }),
    run: (i: any) => { got = i; return "refunded"; },
  });
  const f = fakeClient([msg({ stop_reason: "tool_use", content: [toolUse("u1", "refund", { amount: 40 })] }), msg({ content: [text("ok")] })]);
  await new Agent({ client: f.client, tools: [t] }).run("go");
  eq(got, { amount: 40 }, "parsed input handed to run()");
  ok(typeof got.amount === "number", "value must be typed, not raw");
  return "ran with {amount: 40}";
});

// ---------- C5: unknown tool ----------
await check("C5", "an unknown tool returns an error result rather than throwing", async () => {
  const t = defineTool({ name: "read", description: "Reads.", input: z.object({ p: z.string() }), run: () => "x" });
  const f = fakeClient([msg({ stop_reason: "tool_use", content: [toolUse("u1", "nope", {})] }), msg({ content: [text("ok")] })]);
  await new Agent({ client: f.client, tools: [t] }).run("go");
  const rs = resultsIn(lastMsg(f.requests[1]));
  ok(rs[0]?.is_error === true, "must be an error result");
  return String(rs[0].content).slice(0, 70);
});

// ---------- C6: a throwing tool body ----------
await check("C6", "a throwing tool body becomes an error result", async () => {
  const t = defineTool({ name: "boom", description: "Throws.", input: z.object({}), run: () => { throw new Error("disk on fire"); } });
  const f = fakeClient([msg({ stop_reason: "tool_use", content: [toolUse("u1", "boom", {})] }), msg({ content: [text("ok")] })]);
  const r = await new Agent({ client: f.client, tools: [t] }).run("go");
  const rs = resultsIn(lastMsg(f.requests[1]));
  ok(rs[0]?.is_error === true, "must be an error result");
  ok(r.text === "ok", "run must continue");
  return "error result, run continued";
});

// ---------- C7: parallel results in ONE user message ----------
await check("C7", "parallel results come back in a single user message", async () => {
  const t1 = defineTool({ name: "a", description: "A.", input: z.object({}), run: async () => "ra" });
  const t2 = defineTool({ name: "b", description: "B.", input: z.object({}), run: async () => "rb" });
  const f = fakeClient([
    msg({ stop_reason: "tool_use", content: [toolUse("u1", "a", {}), toolUse("u2", "b", {})] }),
    msg({ content: [text("ok")] }),
  ]);
  await new Agent({ client: f.client, tools: [t1, t2] }).run("go");
  const second = f.requests[1].messages;
  const tail = second[second.length - 1];
  eq(tail.role, "user", "last message role");
  const rs = resultsIn(tail);
  eq(rs.length, 2, "result blocks in the final user message");
  eq(new Set(rs.map((r: any) => r.tool_use_id)).size, 2, "distinct tool_use_ids");
  const userMsgsWithResults = second.filter((m: any) => resultsIn(m).length > 0).length;
  eq(userMsgsWithResults, 1, "number of user messages carrying results");
  return "one user message, two result blocks";
});

// ---------- C8: pruning empties blocks and keeps pairing ----------
await check("C8", "pruning empties the oldest tool result and preserves pairing", async () => {
  const t = defineTool({ name: "read", description: "Reads.", input: z.object({ n: z.number() }), run: (i: any) => "PAYLOAD".repeat(200) + i.n });
  const script = [
    msg({ stop_reason: "tool_use", content: [toolUse("u1", "read", { n: 1 })] }),
    msg({ stop_reason: "tool_use", content: [toolUse("u2", "read", { n: 2 })] }),
    msg({ stop_reason: "tool_use", content: [toolUse("u3", "read", { n: 3 })] }),
    msg({ content: [text("done")] }),
  ];
  // A content-sensitive counter: the number falls once payloads are cleared, so
  // pruning can actually bring the request back under the ceiling. A counter that
  // returns a constant over-budget value would (correctly) force an overflow error.
  const f = fakeClient(script, (p: any) => JSON.stringify(p.messages ?? []).length);
  const placeholder = "[cleared]";
  const a = new Agent({ client: f.client, tools: [t], budget: { maxInputTokens: 2500, keepRecentResults: 1, placeholder } });
  const r = await a.run("go");
  const sent = f.requests[f.requests.length - 1].messages;
  ok(pairingIntact(sent), "tool_use/tool_result pairing must survive pruning");
  const allResults: any[] = [];
  for (const m of sent) allResults.push(...resultsIn(m));
  ok(allResults.length >= 2, `expected the result blocks to remain (got ${allResults.length})`);
  const cleared = allResults.filter((b) => String(b.content) === placeholder).length;
  ok(cleared >= 1, "at least one old result must be emptied to the placeholder");
  const newest = allResults[allResults.length - 1];
  ok(String(newest.content) !== placeholder, "the most recent result must not be cleared");
  ok(f.counts.length > 0, "the budget must consult countTokens");
  const pruned = r.trace.filter((e: any) => e.type === "context_pruned").length;
  return `pairing intact, ${cleared} cleared, newest kept, countTokens called ${f.counts.length}x, context_pruned events: ${pruned}`;
});

// ---------- C9: token counts come from the API ----------
await check("C9", "the budget decision uses the API token counter", async () => {
  const f = fakeClient([msg({ content: [text("ok")] })], () => 5);
  await new Agent({ client: f.client, budget: { maxInputTokens: 100_000 } }).run("go");
  ok(f.counts.length > 0, "countTokens was never called with a budget configured");
  return `countTokens called ${f.counts.length}x`;
});

// ---------- C10: verification send-back ----------
await check("C10", "a failed verification sends the model back with the feedback", async () => {
  const f = fakeClient([msg({ content: [text("no citation")] }), msg({ content: [text("see billing/refunds.md")] })]);
  let seen = 0;
  const a = new Agent({
    client: f.client,
    verify: ({ text: t }: any) => (/\.\w+\b/.test(t) ? { ok: true } : (seen++, { ok: false, feedback: "Cite an article." })),
  });
  const r = await a.run("go");
  eq(r.verified, true, "verified");
  ok(seen === 1, "verifier should have failed exactly once");
  const flat = JSON.stringify(f.requests[1].messages);
  ok(flat.includes("Cite an article."), "feedback must be sent back as a turn");
  return `sent back once, verified=true, steps=${r.steps}`;
});

// ---------- C11: verification exhausted ----------
await check("C11", "exhausted verification returns verified:false and does not throw", async () => {
  const f = fakeClient([msg({ content: [text("a")] }), msg({ content: [text("b")] }), msg({ content: [text("c")] })]);
  const a = new Agent({ client: f.client, maxVerifyAttempts: 1, verify: () => ({ ok: false, feedback: "nope" }) });
  const r = await a.run("go");
  eq(r.verified, false, "verified must be false, not true and not a throw");
  return `verified=false after ${r.steps} steps`;
});

// ---------- C12: no verifier means no opinion ----------
await check("C12", "no verifier yields verified:null", async () => {
  const f = fakeClient([msg({ content: [text("x")] })]);
  const r = await new Agent({ client: f.client }).run("go");
  eq(r.verified, null, "verified");
  return "verified=null";
});

// ---------- C13: refusal ----------
await check("C13", "a refusal raises and carries the trace", async () => {
  const f = fakeClient([msg({ stop_reason: "refusal", content: [], stop_details: { type: "refusal", category: "cyber", explanation: "no" } })]);
  let err: any = null;
  try { await new Agent({ client: f.client }).run("go"); } catch (e) { err = e; }
  ok(err !== null, "must raise on refusal rather than returning empty text");
  ok(Array.isArray(err.trace), "the raised error should carry the trace");
  return `raised ${err.constructor.name}, trace attached`;
});

// ---------- C14: pause_turn resumes ----------
await check("C14", "pause_turn is resumed, not treated as the answer", async () => {
  const f = fakeClient([msg({ stop_reason: "pause_turn", content: [text("partial")] }), msg({ content: [text("complete answer")] })]);
  const r = await new Agent({ client: f.client }).run("go");
  eq(r.text, "complete answer", "final text");
  eq(f.calls(), 2, "model calls");
  return "resumed and returned the complete answer";
});

// ---------- C15: step ceiling ----------
await check("C15", "the step ceiling raises with the trace", async () => {
  const t = defineTool({ name: "a", description: "A.", input: z.object({}), run: () => "r" });
  const script = Array.from({ length: 10 }, (_, i) => msg({ stop_reason: "tool_use", content: [toolUse(`u${i}`, "a", {})] }));
  const f = fakeClient(script);
  let err: any = null;
  try { await new Agent({ client: f.client, tools: [t], maxSteps: 3 }).run("go"); } catch (e) { err = e; }
  ok(err !== null, "must raise when the ceiling is hit");
  ok(Array.isArray(err.trace), "error should carry the trace");
  return `raised ${err.constructor.name} after ${f.calls()} calls`;
});

// ---------- C16: rejected parameters are never sent ----------
await check("C16", "no rejected sampling or tool_choice parameters are sent", async () => {
  const t = defineTool({ name: "a", description: "A.", input: z.object({}), run: () => "r" });
  const f = fakeClient([msg({ stop_reason: "tool_use", content: [toolUse("u1", "a", {})] }), msg({ content: [text("ok")] })]);
  await new Agent({ client: f.client, tools: [t] }).run("go");
  for (const r of f.requests) {
    for (const bad of ["temperature", "top_p", "top_k"]) ok(!(bad in r), `${bad} must not be sent`);
    if (r.tool_choice) {
      const ty = r.tool_choice.type;
      ok(ty !== "any" && ty !== "tool", `tool_choice ${ty} is rejected on current models`);
    }
    if (r.thinking) ok(!("budget_tokens" in r.thinking), "thinking.budget_tokens must not be sent");
  }
  return `checked ${f.requests.length} requests, none carried a rejected parameter`;
});

// ---------- C17: tool order is stable across turns ----------
await check("C17", "tool order is identical across requests", async () => {
  const mk = (n: string) => defineTool({ name: n, description: `${n}.`, input: z.object({}), run: () => "r" });
  const f = fakeClient([msg({ stop_reason: "tool_use", content: [toolUse("u1", "zeta", {})] }), msg({ content: [text("ok")] })]);
  await new Agent({ client: f.client, tools: [mk("zeta"), mk("alpha"), mk("mid")] }).run("go");
  const orders = f.requests.map((r) => (r.tools ?? []).map((t: any) => t.name).join(","));
  eq(orders[0], "zeta,alpha,mid", "insertion order must be preserved, not sorted");
  ok(new Set(orders).size === 1, `tool order changed between requests: ${JSON.stringify(orders)}`);
  return `stable: ${orders[0]}`;
});

// ---------- C18: trace records the sequence ----------
await check("C18", "the trace records tool calls and results in order", async () => {
  const t = defineTool({ name: "a", description: "A.", input: z.object({}), run: () => "r" });
  const f = fakeClient([msg({ stop_reason: "tool_use", content: [toolUse("u1", "a", {})] }), msg({ content: [text("ok")] })]);
  const r = await new Agent({ client: f.client, tools: [t] }).run("go");
  const types = r.trace.map((e: any) => e.type);
  ok(types.includes("tool_call"), "trace must include tool_call");
  ok(types.includes("tool_result"), "trace must include tool_result");
  ok(types.indexOf("tool_call") < types.indexOf("tool_result"), "tool_call must precede tool_result");
  return types.join(" -> ");
});

// ---------- C19: onEvent streams the same events ----------
await check("C19", "onEvent receives the events live", async () => {
  const t = defineTool({ name: "a", description: "A.", input: z.object({}), run: () => "r" });
  const f = fakeClient([msg({ stop_reason: "tool_use", content: [toolUse("u1", "a", {})] }), msg({ content: [text("ok")] })]);
  const seen: string[] = [];
  const r = await new Agent({ client: f.client, tools: [t], onEvent: (e: any) => seen.push(e.type) }).run("go");
  ok(seen.length > 0, "onEvent was never called");
  eq(seen.length, r.trace.length, "onEvent count vs trace length");
  return `${seen.length} events streamed`;
});

// ---------- C20: per-run state is isolated ----------
await check("C20", "per-run state does not leak between runs", async () => {
  const t = defineTool({
    name: "count", description: "Counts.", input: z.object({}),
    run: (_i: any, ctx: any) => { ctx.state.n = ((ctx.state.n as number) ?? 0) + 1; return String(ctx.state.n); },
  });
  const mk = () => fakeClient([msg({ stop_reason: "tool_use", content: [toolUse("u1", "count", {})] }), msg({ content: [text("ok")] })]);
  const a1 = mk(); const agent = new Agent({ client: a1.client, tools: [t] });
  await agent.run("go");
  const first = String(resultsIn(lastMsg(a1.requests[1]))[0].content);
  const a2 = mk();
  const agent2 = new Agent({ client: a2.client, tools: [t] });
  await agent2.run("go");
  const second = String(resultsIn(lastMsg(a2.requests[1]))[0].content);
  eq(first, "1", "first run count");
  eq(second, "1", "second run count (state leaked if this is 2)");
  return "each run started from a fresh state object";
});

// ---------- report ----------
const passed = results.filter((r) => r.passed).length;
console.log(`\n${armDir.split("/").pop()}: ${passed}/${results.length} conformance checks passed\n`);
for (const r of results) console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.id} ${r.name}\n          ${r.detail}`);
console.log("");
process.exit(passed === results.length ? 0 : 1);
