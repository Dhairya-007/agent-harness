Build a typed agent harness for our support-bot project, in TypeScript.

What we need from it, in our own words:

- Tools defined in one place with a Zod schema, so we aren't writing the JSON Schema
  by hand and keeping it in sync.
- A human has to approve a refund over $100 before it happens. Smaller ones go
  through on their own.
- Long tickets shouldn't blow up. Right now a conversation that goes on for a while
  dies on a context error.
- The bot sometimes answers without citing the article it read. We want to check the
  answer before it goes back to the customer, and make it try again if it didn't.
- When it does something wrong, we need to be able to tell what happened without
  re-running the whole thing.
- We're on Node 20. `@anthropic-ai/sdk` (0.71) and `zod` (4.x) are installed.

Write the implementation into `src/` in this directory, split into whatever files
make sense.

`src/index.ts` must export this public surface, exactly — the rest of the design is
yours:

```ts
export function defineTool<S extends z.ZodType>(opts: {
  name: string;
  description: string;
  input: S;
  approval?: (input: z.infer<S>, ctx: ToolContext) => ApprovalDecision | Promise<ApprovalDecision>;
  run(input: z.infer<S>, ctx: ToolContext): string | ToolOutput | Promise<string | ToolOutput>;
}): HarnessTool<z.infer<S>>;

export class Agent {
  constructor(opts: {
    client?: Anthropic;            // inject a client; default to a real one
    model?: string;
    system?: string;
    tools?: readonly AnyHarnessTool[];
    maxSteps?: number;             // default 12
    budget?: { maxInputTokens: number; keepRecentResults?: number; placeholder?: string };
    verify?: (c: { text: string; messages: readonly Anthropic.MessageParam[] }) => VerifyOutcome | Promise<VerifyOutcome>;
    maxVerifyAttempts?: number;    // default 1
    onEvent?: (e: TraceEvent) => void;
  });
  run(input: string | Anthropic.MessageParam[], opts?: { signal?: AbortSignal; state?: Record<string, unknown> }):
    Promise<{
      text: string;
      messages: Anthropic.MessageParam[];
      steps: number;
      stopReason: Anthropic.StopReason | null;
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
      verified: boolean | null;
      trace: TraceEvent[];
    }>;
}
```

Types `ToolContext`, `ApprovalDecision` (`{allow: true} | {allow: false, reason: string}`),
`ToolOutput` (`{content: string, isError?: boolean}`), `VerifyOutcome`
(`{ok: true} | {ok: false, feedback: string}`), `HarnessTool`, `AnyHarnessTool` and
`TraceEvent` must also be exported from `src/index.ts`. Export every error class you
define.

`npx tsc --noEmit` must pass clean under the existing strict `tsconfig.json`.
Don't edit `tsconfig.json` or `package.json`. Don't add dependencies.
