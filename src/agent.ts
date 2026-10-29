import Anthropic from "@anthropic-ai/sdk";
import { ContextBudget, type BudgetOptions } from "./context/budget.js";
import {
  ContextOverflowError,
  MaxStepsExceededError,
  RefusalError,
  ToolInputTruncatedError,
} from "./errors.js";
import { ToolRegistry } from "./tools/registry.js";
import type {
  AnyHarnessTool,
  Effort,
  RunResult,
  TokenUsage,
  TraceEvent,
  Verifier,
} from "./types.js";

/** Claude Opus 5.5 — the current Opus and the right default for agent work. */
export const DEFAULT_MODEL = "claude-opus-5-5";

/**
 * Keeps non-streaming responses under the SDK's HTTP timeout. Streaming runs
 * get a much larger ceiling, because timeouts stop being the constraint.
 */
const DEFAULT_MAX_TOKENS = { streaming: 64_000, blocking: 16_000 } as const;

/** How many times one turn may be re-issued after unparseable tool input. */
const MAX_JSON_REISSUES = 2;

export interface AgentOptions {
  /** Reuse a configured client (retries, timeouts, base URL, Bedrock/Vertex). */
  client?: Anthropic;
  model?: string;
  system?: string;
  tools?: readonly AnyHarnessTool[];
  /** Hard ceiling on model turns in one run. Default 12. */
  maxSteps?: number;
  maxTokens?: number;
  /**
   * Thinking depth. Claude Opus 5.5 cannot turn thinking off, so this is the
   * cost lever; the API default on that model is `medium`.
   */
  effort?: Effort;
  /**
   * Thinking is on by default but its text is omitted. Set `"summarized"` to
   * receive a readable summary of the model's reasoning in the response.
   */
  thinkingDisplay?: "omitted" | "summarized";
  /** Stream text deltas as `text_delta` trace events. Default false. */
  stream?: boolean;
  /** Turn on context pruning by giving it a ceiling. */
  budget?: BudgetOptions;
  /** Runs when the model would stop; can send it back for another pass. */
  verify?: Verifier;
  /** How many times `verify` may send the agent back. Default 1. */
  maxVerifyAttempts?: number;
  onEvent?: (event: TraceEvent) => void;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Seeds the per-run scratch space shared by tools. */
  state?: Record<string, unknown>;
}

type RequestParams = Omit<Anthropic.MessageCreateParamsNonStreaming, "stream">;

function textOf(content: readonly Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

function usageOf(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function addUsage(total: TokenUsage, next: TokenUsage): void {
  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
  total.cacheReadTokens += next.cacheReadTokens;
  total.cacheCreationTokens += next.cacheCreationTokens;
}

/**
 * The loop: ask the model, run the tools it asks for, feed the results back,
 * stop when it is done — with the parts that a bare `while` loop leaves out.
 *
 * What the harness adds over calling the Messages API in a loop:
 *
 * - every tool input is validated against its schema before the tool runs;
 * - a tool can be put behind an approval gate that sees real argument values;
 * - the conversation is held under a token ceiling by clearing old tool output;
 * - a verifier can refuse the model's answer and send it back;
 * - the terminal stop reasons that should not be treated as success — refusal,
 *   truncated tool input, context overflow — are raised as distinct errors;
 * - everything that happened is recorded as a trace you can read or assert on.
 */
export class Agent {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #system: string | undefined;
  readonly #registry: ToolRegistry;
  readonly #maxSteps: number;
  readonly #maxTokens: number;
  readonly #effort: Effort | undefined;
  readonly #thinkingDisplay: "omitted" | "summarized" | undefined;
  readonly #stream: boolean;
  readonly #budget: ContextBudget | undefined;
  readonly #verify: Verifier | undefined;
  readonly #maxVerifyAttempts: number;
  readonly #onEvent: ((event: TraceEvent) => void) | undefined;

  constructor(options: AgentOptions = {}) {
    this.#client = options.client ?? new Anthropic();
    this.#model = options.model ?? DEFAULT_MODEL;
    this.#system = options.system;
    this.#registry = new ToolRegistry(options.tools ?? []);
    this.#maxSteps = options.maxSteps ?? 12;
    this.#stream = options.stream ?? false;
    this.#maxTokens =
      options.maxTokens ??
      (this.#stream ? DEFAULT_MAX_TOKENS.streaming : DEFAULT_MAX_TOKENS.blocking);
    this.#effort = options.effort;
    this.#thinkingDisplay = options.thinkingDisplay;
    this.#budget = options.budget
      ? new ContextBudget(this.#client, this.#model, options.budget)
      : undefined;
    this.#verify = options.verify;
    this.#maxVerifyAttempts = options.maxVerifyAttempts ?? 1;
    this.#onEvent = options.onEvent;
  }

  get tools(): ToolRegistry {
    return this.#registry;
  }

  async run(
    input: string | Anthropic.MessageParam[],
    runOptions: RunOptions = {},
  ): Promise<RunResult> {
    let messages: Anthropic.MessageParam[] =
      typeof input === "string" ? [{ role: "user", content: input }] : [...input];

    const trace: TraceEvent[] = [];
    const emit = (event: TraceEvent): void => {
      trace.push(event);
      this.#onEvent?.(event);
    };

    const totalUsage = emptyUsage();
    const state = runOptions.state ?? {};
    // `strict: true` is the schema guarantee that replaces forced tool choice,
    // which current models reject.
    const tools = this.#registry.definitions({
      eagerInputStreaming: this.#stream && this.#registry.size > 0,
    });

    let verifyAttempts = 0;
    let jsonReissues = 0;

    for (let step = 1; step <= this.#maxSteps; step++) {
      emit({ type: "turn_start", step });

      if (this.#budget) {
        const fitted = await this.#budget.fit({
          messages,
          ...(this.#system ? { system: this.#system } : {}),
          ...(tools.length ? { tools } : {}),
        });
        if (fitted.clearedBlocks > 0) {
          messages = fitted.messages;
          emit({
            type: "context_pruned",
            step,
            clearedBlocks: fitted.clearedBlocks,
            tokensBefore: fitted.tokensBefore,
            tokensAfter: fitted.tokensAfter,
          });
        }
      }

      let message: Anthropic.Message;
      try {
        message = await this.#send(messages, tools, step, emit, runOptions.signal);
        jsonReissues = 0;
      } catch (error) {
        // With eager input streaming the server stops validating tool input,
        // so `finalMessage()` rejects when nothing parseable arrived. That is
        // worth one more attempt; a real API error is not.
        if (error instanceof Anthropic.APIError || jsonReissues >= MAX_JSON_REISSUES) {
          throw error;
        }
        jsonReissues++;
        emit({ type: "retry", step, reason: "tool input was not parseable JSON" });
        continue;
      }

      addUsage(totalUsage, usageOf(message.usage));
      emit({
        type: "turn_end",
        step,
        stopReason: message.stop_reason,
        usage: usageOf(message.usage),
      });

      if (message.stop_reason === "refusal") {
        throw new RefusalError(
          message.stop_details?.category ?? null,
          message.stop_details?.explanation ?? null,
          trace,
        );
      }

      if (message.stop_reason === "model_context_window_exceeded") {
        throw new ContextOverflowError(undefined, trace);
      }

      // A server-side tool hit its iteration limit. Append the turn and
      // re-send to let it continue.
      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content });
        continue;
      }

      const toolUses = message.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      // Input cut off at max_tokens usually still parses as a valid partial
      // object, so the only safe move is to stop rather than run on it.
      if (message.stop_reason === "max_tokens" && toolUses.length > 0) {
        throw new ToolInputTruncatedError(
          toolUses.map((use) => use.name),
          trace,
        );
      }

      if (toolUses.length === 0) {
        const text = textOf(message.content);
        let verified: boolean | null = null;

        if (this.#verify) {
          const candidate: Anthropic.MessageParam = {
            role: "assistant",
            content: message.content,
          };
          // The verifier runs on every candidate answer, including the last
          // one. `maxVerifyAttempts` caps how many times the agent is sent
          // back — not whether the answer it finally returns was checked.
          const outcome = await this.#verify({
            text,
            messages: [...messages, candidate],
          });
          verified = outcome.ok;
          emit({
            type: "verify",
            step,
            passed: outcome.ok,
            ...(outcome.ok ? {} : { feedback: outcome.feedback }),
          });
          if (!outcome.ok && verifyAttempts < this.#maxVerifyAttempts) {
            verifyAttempts++;
            messages.push(candidate);
            messages.push({ role: "user", content: outcome.feedback });
            continue;
          }
        }

        messages.push({ role: "assistant", content: message.content });
        return {
          text,
          messages,
          steps: step,
          stopReason: message.stop_reason,
          usage: totalUsage,
          verified,
          trace,
        };
      }

      messages.push({ role: "assistant", content: message.content });

      // Run the calls concurrently, then return every result in ONE user
      // message. Splitting them across messages teaches the model to stop
      // asking for parallel calls.
      const results = await Promise.all(
        toolUses.map(async (use): Promise<Anthropic.ToolResultBlockParam> => {
          emit({
            type: "tool_call",
            step,
            id: use.id,
            name: use.name,
            input: use.input,
          });

          const outcome = await this.#registry.execute(use.name, use.input, {
            step,
            signal: runOptions.signal,
            state,
          });

          if (outcome.rejection === "unknown_tool") {
            emit({ type: "tool_unknown", step, name: use.name });
          } else if (outcome.rejection === "invalid_input") {
            emit({
              type: "tool_invalid_input",
              step,
              name: use.name,
              issues: outcome.detail ?? "",
            });
          } else if (outcome.rejection === "denied") {
            emit({
              type: "tool_denied",
              step,
              name: use.name,
              reason: outcome.detail ?? "",
            });
          }

          emit({
            type: "tool_result",
            step,
            id: use.id,
            name: use.name,
            ok: !outcome.isError,
            durationMs: outcome.durationMs,
          });

          return {
            type: "tool_result",
            tool_use_id: use.id,
            content: outcome.content,
            ...(outcome.isError ? { is_error: true } : {}),
          };
        }),
      );

      messages.push({ role: "user", content: results });
    }

    throw new MaxStepsExceededError(this.#maxSteps, trace);
  }

  async #send(
    messages: Anthropic.MessageParam[],
    tools: Anthropic.Tool[],
    step: number,
    emit: (event: TraceEvent) => void,
    signal: AbortSignal | undefined,
  ): Promise<Anthropic.Message> {
    const params: RequestParams = {
      model: this.#model,
      max_tokens: this.#maxTokens,
      // A snapshot, not the live array. The loop keeps pushing to `messages`,
      // and handing that same reference out means anything holding a request
      // body — an interceptor, a log, a test — sees it change underneath.
      messages: [...messages],
    };
    if (this.#system) params.system = this.#system;
    if (tools.length > 0) params.tools = tools;
    if (this.#effort) params.output_config = { effort: this.#effort };
    if (this.#thinkingDisplay) {
      params.thinking = { type: "adaptive", display: this.#thinkingDisplay };
    }

    const requestOptions = signal ? { signal } : undefined;

    if (!this.#stream) {
      return await this.#client.messages.create(params, requestOptions);
    }

    const stream = this.#client.messages.stream(params, requestOptions);
    stream.on("text", (delta: string) => {
      emit({ type: "text_delta", step, text: delta });
    });
    return await stream.finalMessage();
  }
}
