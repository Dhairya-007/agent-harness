/**
 * Everything at once: an agent that answers questions about a directory.
 *
 * It shows the four things the harness exists for —
 *   1. tools whose inputs are validated before they run;
 *   2. an approval gate that sees real argument values;
 *   3. a context budget that clears old file contents as the run grows;
 *   4. a verifier that sends a vague answer back.
 *
 *   ANTHROPIC_API_KEY=... npx tsx examples/repo-qa.ts "where is the agent loop?"
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Agent, defineTool } from "../src/index.js";

const ROOT = path.resolve(process.cwd());
const MAX_BYTES = 40_000;

/**
 * Confines a model-supplied path to the project root.
 *
 * Schema validation says "this is a string"; it says nothing about where the
 * string points. A path from the model is untrusted output, so `..` and
 * absolute paths have to be rejected explicitly. The check is lexical — if the
 * root can contain symlinked directories, canonicalize with `fs.realpath` too.
 */
function resolveInRoot(candidate: string): string | null {
  const target = path.resolve(ROOT, candidate);
  const relative = path.relative(ROOT, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return target;
}

const IGNORED = new Set(["node_modules", ".git", "dist", "coverage"]);

const listFiles = defineTool({
  name: "list_files",
  description:
    "Lists the files and directories at a path, relative to the project root. " +
    "Use it to orient yourself before reading anything.",
  input: z.object({
    path: z.string().default(".").describe("Directory relative to the project root"),
  }),
  async run({ path: candidate }) {
    const target = resolveInRoot(candidate);
    if (!target) return { content: "Path escapes the project root.", isError: true };

    const entries = await readdir(target, { withFileTypes: true });
    const listing = entries
      .filter((entry) => !IGNORED.has(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
    return listing.length ? listing.join("\n") : "(empty)";
  },
});

const readFileTool = defineTool({
  name: "read_file",
  description:
    "Reads a UTF-8 text file, relative to the project root. Files over " +
    `${MAX_BYTES} bytes are truncated.`,
  input: z.object({
    path: z.string().describe("File relative to the project root"),
  }),
  async run({ path: candidate }) {
    const target = resolveInRoot(candidate);
    if (!target) return { content: "Path escapes the project root.", isError: true };

    const info = await stat(target).catch(() => null);
    if (!info?.isFile()) {
      return { content: `Not a file: ${candidate}`, isError: true };
    }

    const text = await readFile(target, "utf8");
    return text.length > MAX_BYTES
      ? `${text.slice(0, MAX_BYTES)}\n\n[truncated at ${MAX_BYTES} bytes]`
      : text;
  },
});

/**
 * A deliberately dangerous tool, to show the gate. The policy runs on parsed
 * input, so it can reason about the actual path rather than a raw JSON blob.
 */
const deleteFile = defineTool({
  name: "delete_file",
  description: "Deletes a file. Requires approval.",
  input: z.object({ path: z.string() }),
  approval(input) {
    return {
      allow: false,
      reason:
        `deleting ${input.path} needs a human. Report what you would delete ` +
        `and why, and let the user run it.`,
    };
  },
  run: () => "unreachable — the gate above always declines",
});

const question = process.argv.slice(2).join(" ") || "What does this project do?";

const agent = new Agent({
  system: [
    "You answer questions about the code in this repository.",
    "Look before you answer: list directories, read the files that matter, and",
    "ground every claim in something you actually read. Cite file paths.",
    "If you cannot find something, say so rather than guessing.",
  ].join(" "),
  tools: [listFiles, readFileTool, deleteFile],
  effort: "high",
  maxSteps: 16,
  // File contents dominate an agent transcript. Hold the request under a
  // working ceiling by clearing the oldest reads once they have been used.
  budget: { maxInputTokens: 120_000, keepRecentResults: 4 },
  // Reject an answer that cites nothing — the most common failure here is a
  // confident summary that never opened a file.
  verify({ text }) {
    const citesAFile = /[\w./-]+\.(ts|js|json|md|yml|yaml)\b/.test(text);
    return citesAFile
      ? { ok: true }
      : {
          ok: false,
          feedback:
            "That answer cites no file. Read the relevant files and answer " +
            "again, naming the paths you relied on.",
        };
  },
  onEvent(event) {
    switch (event.type) {
      case "tool_call":
        console.error(`  → ${event.name} ${JSON.stringify(event.input)}`);
        break;
      case "tool_denied":
        console.error(`  ⛔ ${event.name}: ${event.reason}`);
        break;
      case "context_pruned":
        console.error(
          `  ✂ cleared ${event.clearedBlocks} old results ` +
            `(${event.tokensBefore} → ${event.tokensAfter} tokens)`,
        );
        break;
      case "verify":
        console.error(`  ${event.passed ? "✓" : "↩"} verify${event.passed ? "" : `: ${event.feedback}`}`);
        break;
      default:
        break;
    }
  },
});

const result = await agent.run(question);

console.log(`\n${result.text}\n`);
console.log(
  `${result.steps} turns · ${result.usage.inputTokens} in / ${result.usage.outputTokens} out` +
    ` · verified: ${result.verified}`,
);
