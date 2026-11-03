import Anthropic from "@anthropic-ai/sdk";
import { Registry } from "./tools.js";

const client = new Anthropic({ maxRetries: 2 });
const MODEL = "claude-sonnet-5-5";
const MAX_INPUT_TOKENS = 150_000;

/** Cheap stand-in for a tokenizer. Good enough to decide when to trim. */
function estimateTokens(messages: Anthropic.MessageParam[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/**
 * Drops the oldest turns once the transcript gets long. Tool output is the
 * bulk of it and the model has usually moved on by then.
 */
function trim(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (estimateTokens(messages) <= MAX_INPUT_TOKENS) return messages;
  const [first, ...rest] = messages;
  return [first, ...rest.slice(-10)];
}

export async function runAgent(question: string, systemPrompt: string) {
  const registry = new Registry();
  const tools = registry.definitions();
  let messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];

  for (let step = 1; step <= 12; step++) {
    messages = trim(messages);

    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 8192,
      temperature: 0,
      system: systemPrompt,
      tools,
      messages,
    });

    console.log(`[step ${step}] stop=${message.stop_reason} out=${message.usage.output_tokens}`);

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { text, steps: step };
    }

    messages.push({ role: "assistant", content: message.content });

    for (const use of toolUses) {
      console.log(`  -> ${use.name}(${JSON.stringify(use.input)})`);
      const result = await registry.call(use.name, use.input);
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: use.id,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          },
        ],
      });
    }
  }

  throw new Error("agent exceeded 12 steps without an answer");
}
