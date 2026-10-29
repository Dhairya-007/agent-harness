import type Anthropic from "@anthropic-ai/sdk";

export interface BudgetOptions {
  /**
   * Prune once a request is projected to exceed this many input tokens. This
   * is a working ceiling you choose for cost and latency, not the model's
   * context window — set it well below the window.
   */
  maxInputTokens: number;
  /**
   * Never clear this many of the most recent tool results. The model is
   * usually mid-thought about them, and clearing them makes it repeat work.
   */
  keepRecentResults?: number;
  /** Stands in for a cleared result so the turn structure survives. */
  placeholder?: string;
}

const DEFAULTS = {
  keepRecentResults: 4,
  placeholder: "[earlier tool output cleared to stay within the context budget]",
} as const;

/** Rough token estimate. Only used to decide *how many* blocks to clear. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function blockText(content: Anthropic.ToolResultBlockParam["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}

interface ToolResultRef {
  messageIndex: number;
  blockIndex: number;
  tokens: number;
}

/** Locates every tool_result block in the conversation, oldest first. */
function findToolResults(
  messages: readonly Anthropic.MessageParam[],
): ToolResultRef[] {
  const refs: ToolResultRef[] = [];
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      if (block.type !== "tool_result") return;
      refs.push({
        messageIndex,
        blockIndex,
        tokens: estimateTokens(blockText(block.content)),
      });
    });
  });
  return refs;
}

export interface FitResult {
  messages: Anthropic.MessageParam[];
  tokensBefore: number;
  tokensAfter: number;
  clearedBlocks: number;
}

/**
 * Keeps a conversation inside a token ceiling by clearing the oldest tool
 * output.
 *
 * Tool results are the right thing to drop first: they are the bulkiest part
 * of an agent transcript and the least load-bearing once the model has acted
 * on them, while the assistant turns that reference them carry the reasoning
 * and must stay. Clearing preserves the tool_use/tool_result pairing that the
 * API requires — only the payload is replaced.
 *
 * Token counts come from the Models API, never from a local tokenizer, which
 * would disagree with the server and drift between model generations. The
 * char-based estimate is used only to pick how many blocks to clear before
 * paying for a second count.
 */
export class ContextBudget {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #maxInputTokens: number;
  readonly #keepRecentResults: number;
  readonly #placeholder: string;

  constructor(client: Anthropic, model: string, options: BudgetOptions) {
    this.#client = client;
    this.#model = model;
    this.#maxInputTokens = options.maxInputTokens;
    this.#keepRecentResults = options.keepRecentResults ?? DEFAULTS.keepRecentResults;
    this.#placeholder = options.placeholder ?? DEFAULTS.placeholder;
  }

  get maxInputTokens(): number {
    return this.#maxInputTokens;
  }

  /** Authoritative input-token count for the request as it stands. */
  async measure(request: {
    messages: Anthropic.MessageParam[];
    system?: string;
    tools?: Anthropic.Tool[];
  }): Promise<number> {
    const counted = await this.#client.messages.countTokens({
      model: this.#model,
      messages: request.messages,
      ...(request.system ? { system: request.system } : {}),
      ...(request.tools?.length ? { tools: request.tools } : {}),
    });
    return counted.input_tokens;
  }

  /**
   * Clears the oldest tool results until the estimated saving covers
   * `tokensToFree`. Returns a new array; the input is not mutated.
   */
  prune(
    messages: readonly Anthropic.MessageParam[],
    tokensToFree: number,
  ): { messages: Anthropic.MessageParam[]; clearedBlocks: number } {
    const refs = findToolResults(messages);
    const eligible = refs.slice(0, Math.max(0, refs.length - this.#keepRecentResults));
    if (eligible.length === 0 || tokensToFree <= 0) {
      return { messages: [...messages], clearedBlocks: 0 };
    }

    const placeholderCost = estimateTokens(this.#placeholder);
    const toClear: ToolResultRef[] = [];
    let freed = 0;
    for (const ref of eligible) {
      if (freed >= tokensToFree) break;
      const saving = ref.tokens - placeholderCost;
      if (saving <= 0) continue;
      toClear.push(ref);
      freed += saving;
    }
    if (toClear.length === 0) {
      return { messages: [...messages], clearedBlocks: 0 };
    }

    const touched = new Map<number, Set<number>>();
    for (const ref of toClear) {
      const blocks = touched.get(ref.messageIndex) ?? new Set<number>();
      blocks.add(ref.blockIndex);
      touched.set(ref.messageIndex, blocks);
    }

    const next = messages.map((message, messageIndex) => {
      const blocks = touched.get(messageIndex);
      if (!blocks || !Array.isArray(message.content)) return message;
      return {
        ...message,
        content: message.content.map((block, blockIndex) =>
          blocks.has(blockIndex) && block.type === "tool_result"
            ? { ...block, content: this.#placeholder }
            : block,
        ),
      } as Anthropic.MessageParam;
    });

    return { messages: next, clearedBlocks: toClear.length };
  }

  /** Measures, prunes if the request is over budget, then measures again. */
  async fit(request: {
    messages: Anthropic.MessageParam[];
    system?: string;
    tools?: Anthropic.Tool[];
  }): Promise<FitResult> {
    const tokensBefore = await this.measure(request);
    if (tokensBefore <= this.#maxInputTokens) {
      return {
        messages: request.messages,
        tokensBefore,
        tokensAfter: tokensBefore,
        clearedBlocks: 0,
      };
    }

    const { messages, clearedBlocks } = this.prune(
      request.messages,
      tokensBefore - this.#maxInputTokens,
    );
    if (clearedBlocks === 0) {
      return {
        messages: request.messages,
        tokensBefore,
        tokensAfter: tokensBefore,
        clearedBlocks: 0,
      };
    }

    const tokensAfter = await this.measure({ ...request, messages });
    return { messages, tokensBefore, tokensAfter, clearedBlocks };
  }
}
