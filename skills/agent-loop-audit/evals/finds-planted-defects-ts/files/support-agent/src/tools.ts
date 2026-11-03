import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";

const DOCS_ROOT = path.resolve(process.cwd(), "knowledge-base");

export interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  needsApproval?: boolean;
  run(input: any): Promise<string>;
}

/** Reads a markdown article out of the knowledge base. */
const readArticle: Tool = {
  name: "read_article",
  description: "Reads a knowledge-base article by its relative path, e.g. 'billing/refunds.md'.",
  schema: z.object({ article_path: z.string() }),
  async run(input) {
    const full = path.join(DOCS_ROOT, input.article_path);
    return fs.readFileSync(full, "utf8");
  },
};

const searchArticles: Tool = {
  name: "search_articles",
  description: "Full-text search over the knowledge base. Returns up to `limit` matching paths.",
  schema: z.object({ query: z.string(), limit: z.number().int().max(50).default(10) }),
  async run(input) {
    const hits: string[] = [];
    for (const file of fs.readdirSync(DOCS_ROOT, { recursive: true }) as string[]) {
      if (!file.endsWith(".md")) continue;
      const body = fs.readFileSync(path.join(DOCS_ROOT, file), "utf8");
      if (body.toLowerCase().includes(input.query.toLowerCase())) hits.push(file);
      if (hits.length >= input.limit) break;
    }
    return hits.join("\n") || "no matches";
  },
};

const issueRefund: Tool = {
  name: "issue_refund",
  description: "Issues a refund to a customer. Amounts over $100 require a human.",
  schema: z.object({
    customer_id: z.string(),
    amount_usd: z.number().positive(),
    reason: z.string(),
  }),
  needsApproval: true,
  async run(input) {
    // Gate the big ones. Anything over a hundred dollars is a human's call.
    if (input.amount_usd > 100) {
      throw new Error(`refund of $${input.amount_usd} exceeds the automatic limit`);
    }
    const res = await fetch("https://billing.internal/refunds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return `refund ${res.status === 200 ? "issued" : "failed"} for ${input.customer_id}`;
  },
};

const escalate: Tool = {
  name: "escalate_to_human",
  description: "Hands the conversation to a human agent, with a summary of what was tried.",
  schema: z.object({ summary: z.string(), urgency: z.enum(["low", "normal", "high"]) }),
  async run(input) {
    await fetch("https://desk.internal/escalations", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return "escalated";
  },
};

const ALL = [readArticle, searchArticles, issueRefund, escalate];

export class Registry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = ALL) {
    for (const t of tools) {
      if (this.tools.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
      this.tools.set(t.name, t);
    }
  }

  /** Wire definitions, in insertion order so the cached prefix stays stable. */
  definitions(): Anthropic.Tool[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: z.toJSONSchema(t.schema, { target: "draft-7" }) as any,
    }));
  }

  async call(name: string, input: unknown): Promise<{ content: string; isError: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: `No tool named "${name}". Available: ${[...this.tools.keys()].join(", ")}.`,
        isError: true,
      };
    }
    try {
      return { content: await tool.run(input), isError: false };
    } catch (err) {
      return { content: `Tool "${name}" failed: ${(err as Error).message}`, isError: true };
    }
  }
}
