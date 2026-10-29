import type { TraceEvent } from "./types.js";

/**
 * Base class for every failure the harness raises itself. API failures are
 * left as the SDK's own typed errors (`Anthropic.RateLimitError` and friends)
 * so callers can tell "the model refused" apart from "we were rate limited".
 */
export class HarnessError extends Error {
  /** The trace up to the point of failure — the useful half of a bug report. */
  readonly trace: readonly TraceEvent[];

  constructor(message: string, trace: readonly TraceEvent[] = []) {
    super(message);
    this.name = new.target.name;
    this.trace = trace;
  }
}

/** The run hit `maxSteps` without the model finishing. */
export class MaxStepsExceededError extends HarnessError {
  readonly steps: number;

  constructor(steps: number, trace: readonly TraceEvent[] = []) {
    super(`agent did not finish within ${steps} steps`, trace);
    this.steps = steps;
  }
}

/**
 * The model declined the request (`stop_reason: "refusal"`). Never run the
 * tools from a refused turn — a refusal can cut a tool input off mid-stream.
 */
export class RefusalError extends HarnessError {
  readonly category: string | null;
  readonly explanation: string | null;

  constructor(
    category: string | null,
    explanation: string | null,
    trace: readonly TraceEvent[] = [],
  ) {
    super(
      `model refused the request${category ? ` (${category})` : ""}${
        explanation ? `: ${explanation}` : ""
      }`,
      trace,
    );
    this.category = category;
    this.explanation = explanation;
  }
}

/**
 * A turn stopped at `max_tokens` while a tool input was still being written.
 * The partial JSON often parses cleanly, which is exactly why this is an error
 * and not a warning: running the tool would run it on truncated arguments.
 */
export class ToolInputTruncatedError extends HarnessError {
  constructor(toolNames: string[], trace: readonly TraceEvent[] = []) {
    super(
      `tool input truncated at max_tokens (${toolNames.join(", ")}); retry with a higher maxTokens`,
      trace,
    );
  }
}

/** The conversation no longer fits, and pruning could not recover enough room. */
export class ContextOverflowError extends HarnessError {
  constructor(message = "conversation exceeded the model's context window", trace: readonly TraceEvent[] = []) {
    super(message, trace);
  }
}

/** The model produced tool input that never parsed as JSON, repeatedly. */
export class UnparseableToolInputError extends HarnessError {
  constructor(attempts: number, trace: readonly TraceEvent[] = []) {
    super(`tool input was not parseable JSON after ${attempts} attempts`, trace);
  }
}
