import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type {
  AnyHarnessTool,
  ApprovalPolicy,
  HarnessTool,
  ParseResult,
  ToolContext,
  ToolOutput,
} from "../types.js";

export interface DefineToolOptions<Schema extends z.ZodType> {
  name: string;
  /**
   * What the tool does, in as much detail as you can stand to write. This is
   * the single biggest lever on whether the model calls it correctly.
   */
  description: string;
  /** One Zod schema, used both for the wire schema and for validation. */
  input: Schema;
  /** Defaults to `"auto"`. */
  approval?: ApprovalPolicy<z.infer<Schema>>;
  run(
    input: z.infer<Schema>,
    ctx: ToolContext,
  ): string | ToolOutput | Promise<string | ToolOutput>;
}

function normalize(output: string | ToolOutput): ToolOutput {
  return typeof output === "string" ? { content: output } : output;
}

/**
 * Builds a tool from a Zod schema.
 *
 * The schema does double duty: it is converted once to JSON Schema for the
 * request, and it validates the model's arguments before `run` is reached.
 * That second half is not optional. With eager input streaming the API stops
 * validating tool input, and the SDK's tolerant parser will hand back a
 * silently truncated object rather than throwing — so a tool that trusts its
 * input runs on half an argument and reports success.
 */
export function defineTool<Schema extends z.ZodType>(
  opts: DefineToolOptions<Schema>,
): HarnessTool<z.infer<Schema>> {
  const jsonSchema = z.toJSONSchema(opts.input, {
    target: "draft-7",
  }) as Record<string, unknown>;

  // The API wants a bare object schema. `$schema` is noise on the wire, and
  // `strict: true` additionally requires `additionalProperties: false`, which
  // Zod already emits for plain objects — set it defensively for the rest.
  delete jsonSchema["$schema"];
  if (jsonSchema["type"] !== "object") {
    throw new TypeError(
      `tool "${opts.name}": input schema must be an object, got ${String(jsonSchema["type"])}`,
    );
  }
  if (!("additionalProperties" in jsonSchema)) {
    jsonSchema["additionalProperties"] = false;
  }

  return {
    name: opts.name,
    description: opts.description,
    jsonSchema: jsonSchema as unknown as Anthropic.Tool.InputSchema,
    approval: opts.approval ?? "auto",
    parse(raw: unknown): ParseResult<z.infer<Schema>> {
      const parsed = opts.input.safeParse(raw);
      if (parsed.success) return { ok: true, value: parsed.data };
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return { ok: false, issues };
    },
    async run(input, ctx) {
      return normalize(await opts.run(input, ctx));
    },
  };
}

/** The outcome of one tool call, before it becomes a `tool_result` block. */
export interface ExecutionOutcome extends ToolOutput {
  /** Why the call did not reach `run`, when it did not. */
  rejection?: "unknown_tool" | "invalid_input" | "denied";
  /** Validation issues or the approval gate's reason. */
  detail?: string;
  durationMs: number;
}

/**
 * Holds the tool surface for one agent and runs calls against it.
 *
 * `execute` never throws for a tool-level problem. An unknown tool, bad
 * arguments, a refused approval and a thrown exception all come back as an
 * error result, because the model can read those and correct itself — while an
 * exception would end the run.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, AnyHarnessTool>();

  constructor(tools: readonly AnyHarnessTool[] = []) {
    for (const tool of tools) this.add(tool);
  }

  add(tool: AnyHarnessTool): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
    return this;
  }

  get size(): number {
    return this.#tools.size;
  }

  get names(): string[] {
    return [...this.#tools.keys()];
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  /**
   * Renders the wire definitions.
   *
   * `strict: true` is always on: forced tool choice returns a 400 on current
   * models, so schema-valid arguments under `tool_choice: auto` are the
   * remaining guarantee. Tool order is insertion order and must stay stable —
   * the tool block is the first thing in the cached prefix, so reordering it
   * invalidates the whole cache.
   */
  definitions(opts: { eagerInputStreaming?: boolean } = {}): Anthropic.Tool[] {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.jsonSchema,
      strict: true,
      ...(opts.eagerInputStreaming ? { eager_input_streaming: true } : {}),
    }));
  }

  async execute(
    name: string,
    rawInput: unknown,
    ctx: ToolContext,
  ): Promise<ExecutionOutcome> {
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;

    const tool = this.#tools.get(name);
    if (!tool) {
      return {
        content: `No tool named "${name}". Available tools: ${this.names.join(", ") || "(none)"}.`,
        isError: true,
        rejection: "unknown_tool",
        durationMs: elapsed(),
      };
    }

    const parsed = tool.parse(rawInput);
    if (!parsed.ok) {
      return {
        content: `Invalid input for "${name}": ${parsed.issues}. Call it again with arguments matching the schema.`,
        isError: true,
        rejection: "invalid_input",
        detail: parsed.issues,
        durationMs: elapsed(),
      };
    }

    if (typeof tool.approval === "function") {
      const decision = await tool.approval(parsed.value, ctx);
      if (!decision.allow) {
        return {
          content: `Call to "${name}" was not approved: ${decision.reason}`,
          isError: true,
          rejection: "denied",
          detail: decision.reason,
          durationMs: elapsed(),
        };
      }
    }

    try {
      const output = await tool.run(parsed.value, ctx);
      return { ...output, durationMs: elapsed() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: `Tool "${name}" failed: ${message}`,
        isError: true,
        durationMs: elapsed(),
      };
    }
  }
}
