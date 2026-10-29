import type Anthropic from "@anthropic-ai/sdk";

/**
 * How much effort the model spends on a turn. On Claude Opus 5.5 this is the
 * only depth control — thinking cannot be disabled — and the API default is
 * `medium`.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Passed to every tool `run`, so a tool can see where it sits in the run. */
export interface ToolContext {
  /** 1-based index of the turn that produced this call. */
  readonly step: number;
  /** Aborts when the caller aborts the run. */
  readonly signal: AbortSignal | undefined;
  /** Scratch space shared by every tool for the length of one run. */
  readonly state: Record<string, unknown>;
}

/** What a tool hands back to the model. */
export interface ToolOutput {
  content: string;
  /** Sent as `is_error: true`, so the model can see the failure and adapt. */
  isError?: boolean;
}

export type ApprovalDecision = { allow: true } | { allow: false; reason: string };

/**
 * Decides whether a call may run. `"auto"` always allows. A function receives
 * the already-validated input, so a gate can read real values rather than
 * guessing from raw JSON.
 */
export type ApprovalPolicy<Input> =
  | "auto"
  | ((input: Input, ctx: ToolContext) => ApprovalDecision | Promise<ApprovalDecision>);

/** The result of validating raw model output against a tool's schema. */
export type ParseResult<Input> =
  | { ok: true; value: Input }
  | { ok: false; issues: string };

/**
 * A tool the harness can run. Build these with `defineTool` rather than by
 * hand — it derives `jsonSchema` and `parse` from one Zod schema, so the
 * schema the model sees and the validation that guards execution cannot drift.
 */
export interface HarnessTool<Input = unknown> {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Anthropic.Tool.InputSchema;
  readonly approval: ApprovalPolicy<Input>;
  parse(raw: unknown): ParseResult<Input>;
  run(input: Input, ctx: ToolContext): Promise<ToolOutput>;
}

/**
 * A tool whose input shape is not known to the holder. Collections mix tools
 * with different input types, and `HarnessTool` is invariant in `Input`
 * (it both consumes and is parameterised by it), so a shared supertype is the
 * only thing a heterogeneous array can be typed as. `defineTool` keeps the
 * precise type at the definition site, which is where it earns its keep.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyHarnessTool = HarnessTool<any>;

/** Everything the harness observed, in order. */
export type TraceEvent =
  | { type: "turn_start"; step: number }
  | {
      type: "turn_end";
      step: number;
      stopReason: Anthropic.StopReason | null;
      usage: TokenUsage;
    }
  | { type: "text_delta"; step: number; text: string }
  | { type: "tool_call"; step: number; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      step: number;
      id: string;
      name: string;
      ok: boolean;
      durationMs: number;
    }
  | { type: "tool_denied"; step: number; name: string; reason: string }
  | { type: "tool_invalid_input"; step: number; name: string; issues: string }
  | { type: "tool_unknown"; step: number; name: string }
  | {
      type: "context_pruned";
      step: number;
      clearedBlocks: number;
      tokensBefore: number;
      tokensAfter: number;
    }
  | { type: "verify"; step: number; passed: boolean; feedback?: string }
  | { type: "retry"; step: number; reason: string };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type VerifyOutcome = { ok: true } | { ok: false; feedback: string };

/**
 * Runs when the model would otherwise stop. Returning `ok: false` sends the
 * feedback back as a user turn and lets the agent try again.
 */
export type Verifier = (candidate: {
  text: string;
  messages: readonly Anthropic.MessageParam[];
}) => VerifyOutcome | Promise<VerifyOutcome>;

export interface RunResult {
  /** Concatenated text of the final assistant turn. */
  text: string;
  /** The full conversation, ready to pass back into another run. */
  messages: Anthropic.MessageParam[];
  /** How many model turns the run took. */
  steps: number;
  stopReason: Anthropic.StopReason | null;
  usage: TokenUsage;
  /**
   * Whether the returned answer passed `verify`, or `null` when no verifier
   * was configured. `false` means the agent ran out of send-backs and this is
   * the best it managed — worth checking before trusting the text.
   */
  verified: boolean | null;
  trace: TraceEvent[];
}
