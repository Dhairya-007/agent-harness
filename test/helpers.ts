import type Anthropic from "@anthropic-ai/sdk";

/**
 * Builds a `Message` with only the fields a test cares about. The SDK's
 * `Message` has a long tail of nullable metadata that no test asserts on, so
 * the cast keeps the fixtures readable.
 */
export function message(partial: {
  content?: Anthropic.ContentBlock[];
  stop_reason?: Anthropic.StopReason;
  stop_details?: { type: "refusal"; category: string | null; explanation: string | null };
  usage?: Partial<Anthropic.Usage>;
}): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: partial.content ?? [],
    stop_reason: partial.stop_reason ?? "end_turn",
    stop_sequence: null,
    stop_details: partial.stop_details ?? null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      ...partial.usage,
    },
  } as unknown as Anthropic.Message;
}

export function textBlock(text: string): Anthropic.ContentBlock {
  return { type: "text", text, citations: null } as unknown as Anthropic.ContentBlock;
}

export function toolUseBlock(
  id: string,
  name: string,
  input: unknown,
): Anthropic.ContentBlock {
  return { type: "tool_use", id, name, input } as unknown as Anthropic.ContentBlock;
}

export interface FakeClient {
  client: Anthropic;
  /** Every `messages.create` body, in order. */
  requests: Anthropic.MessageCreateParamsNonStreaming[];
  /** Every `messages.countTokens` body, in order. */
  tokenCounts: Anthropic.MessageCountTokensParams[];
}

/**
 * A stand-in for the SDK client that replays a fixed script of responses and
 * records what it was asked. Nothing here reaches the network.
 */
export function fakeClient(
  script: Anthropic.Message[],
  options: { tokenCounter?: (params: Anthropic.MessageCountTokensParams) => number } = {},
): FakeClient {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const tokenCounts: Anthropic.MessageCountTokensParams[] = [];
  let index = 0;

  const client = {
    messages: {
      async create(params: Anthropic.MessageCreateParamsNonStreaming) {
        requests.push(params);
        const next = script[index++];
        if (!next) throw new Error(`fake client: script exhausted at call ${index}`);
        return next;
      },
      async countTokens(params: Anthropic.MessageCountTokensParams) {
        tokenCounts.push(params);
        return { input_tokens: options.tokenCounter?.(params) ?? 0 };
      },
    },
  };

  return { client: client as unknown as Anthropic, requests, tokenCounts };
}

/**
 * Pulls the tool_result blocks out of a message.
 *
 * `MessageParam` is a union whose members type `content` differently, so a
 * predicate passed straight to `.filter` resolves against the union and loses
 * its narrowing. Widening to a single block array first keeps it.
 */
export function toolResultsIn(
  message: Anthropic.MessageParam | undefined,
): Anthropic.ToolResultBlockParam[] {
  if (!message || !Array.isArray(message.content)) return [];
  const blocks = message.content as Anthropic.ContentBlockParam[];
  return blocks.filter(
    (block): block is Anthropic.ToolResultBlockParam => block.type === "tool_result",
  );
}

/** Pulls the tool_result blocks out of a recorded request's last message. */
export function lastToolResults(
  params: Anthropic.MessageCreateParamsNonStreaming,
): Anthropic.ToolResultBlockParam[] {
  return toolResultsIn(params.messages.at(-1));
}
