/**
 * predexec — opencode adapter (read-only MVP).
 *
 * Registers ONE tool, `predexec`, that runs a pre-planned tree of command
 * batches with deterministic branch conditions in a single model round-trip.
 * All real logic lives in ../../core (pure TS, zero harness imports).
 *
 * Native tool ops (read/grep/find/ls) are wired to opencode's v1 SDK client
 * (file.read / find.text / find.files / file.list). Caveats vs pi: file.read
 * has no offset/limit (sliced client-side), and find.text (grep) is
 * directory-scoped with no glob.
 *
 * Export shape: opencode's plugin loader (readV1Plugin, ≥1.17.x) reads ONLY the
 * default export and requires `{ server() }`; older hosts (and KiloCode) also
 * see the named `server` export. Runtime imports are zod + our own modules only —
 * `@opencode-ai/plugin` is type-only, because npm-installed plugins get
 * production deps only and the host does not provide that package at import time.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { Plugin, ToolContext } from "@opencode-ai/plugin";
import {
  runPlanTree,
  coercePlan,
  isDestructiveCommand,
  type PlanTree,
  type ToolOp,
  type ToolExecutor,
} from "../../core/index.ts";
import { STEERING_LINE, VERIFY_FIRST_LINE, systemHasRoutingInstructions } from "../../steering.ts";
import { recordRun } from "../../stats.ts";
import { createPolicyChecker, readOpencodeBashRules } from "../../policy.ts";

const DESCRIPTION =
  "Run read-only shell commands and tool calls with deterministic branching. " +
  "Each node runs shell commands (strings) and/or tool calls ({tool, ...args}) sequentially or concurrently (parallel:true). " +
  "Edges evaluate conditions on output to choose the next node with no model call between levels. " +
  "Use parallel:true for independent reads, cwd for a shared base dir, and edges to branch. " +
  "mutationStop/noEdgeMatch is recoverable — read the transcript and resume with bash. Never retry the same plan blindly. " +
  "Shell commands respect your opencode permission rules — deny/ask matches hard-stop before running. " +
  VERIFY_FIRST_LINE;

/** opencode v1 SDK client (the subset predexec calls). Loosely typed to avoid a hard SDK dep. */
type OpencodeClient = {
  file: {
    read(opts: { query: { path: string; directory?: string } }): Promise<{ data?: { content?: string }; error?: unknown }>;
    list(opts: { query: { path: string; directory?: string } }): Promise<{ data?: Array<{ name?: string; path?: string }>; error?: unknown }>;
  };
  find: {
    text(opts: { query: { pattern: string; directory?: string } }): Promise<{ data?: Array<{ path: { text: string }; lines: { text: string }; line_number: number }>; error?: unknown }>;
    files(opts: { query: { query: string; directory?: string } }): Promise<{ data?: string[]; error?: unknown }>;
  };
};

const errText = (e: unknown): string =>
  typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);

/**
 * Maps a predexec tool op to an opencode SDK call, normalizing the response to
 * the shell-like {stdout, stderr, exitCode} the core engine expects. Exported
 * for unit testing with a mock client.
 */
export function createToolExecutor(client: OpencodeClient, cwd: string): ToolExecutor {
  return async (op: ToolOp, opts) => {
    const directory = opts.cwd ?? cwd;
    // opencode's server surfaces missing paths badly — file.read of a missing
    // file returns empty content with NO error, and file.list throws an opaque
    // 500 ("Unexpected server error") — so read/ls pre-check existence and
    // report the resolved location the model needs to correct its plan.
    const missing = (p: string) =>
      existsSync(isAbsolute(p) ? p : resolve(directory, p))
        ? null
        : { stdout: "", stderr: `path not found: ${p} (resolved against ${directory})`, exitCode: 1 };
    const fail = (label: string, e: unknown) => ({ stdout: "", stderr: `${label}: ${errText(e)}`, exitCode: 1 });
    // grep/find scope by DIRECTORY in opencode's v1 SDK. Honor an op's `path`
    // by resolving it into the query directory; a FILE path fails loudly — the
    // silent alternative (searching the whole repo) is false-hit fuel for edges.
    const scopeDir = (
      p: unknown,
      tool: string,
    ): { dir: string; err?: undefined } | { dir?: undefined; err: { stdout: string; stderr: string; exitCode: number } } => {
      if (p === undefined) return { dir: directory };
      const path = String(p);
      const gone = missing(path);
      if (gone) return { err: gone };
      const abs = isAbsolute(path) ? path : resolve(directory, path);
      try {
        if (!statSync(abs).isDirectory()) {
          return {
            err: {
              stdout: "",
              stderr: `${tool}: opencode can only scope by directory; "${path}" is a file — use a shell command for single files`,
              exitCode: 1,
            },
          };
        }
      } catch {
        /* stat raced away; missing() already vetted existence */
      }
      return { dir: abs };
    };
    const sliceLimit = <T>(items: T[], limit: unknown): T[] =>
      typeof limit === "number" && limit >= 0 ? items.slice(0, limit) : items;
    try {
      switch (op.tool) {
        case "read": {
          const path = String(op.path ?? "");
          const gone = missing(path);
          if (gone) return gone;
          const r = await client.file.read({ query: { path, directory } });
          if (r.error) return fail(`read ${path}`, r.error);
          let content = r.data?.content ?? "";
          // v1 file.read has no offset/limit — apply line-slicing client-side (offset is 1-based).
          if (typeof op.offset === "number" || typeof op.limit === "number") {
            const lines = content.split("\n");
            const start = Math.max(0, (typeof op.offset === "number" ? op.offset : 1) - 1);
            const end = typeof op.limit === "number" ? start + op.limit : lines.length;
            content = lines.slice(start, end).join("\n");
          }
          return { stdout: content, stderr: "", exitCode: 0 };
        }
        case "grep": {
          const pattern = String(op.pattern ?? "");
          const unsupported = ["glob", "ignoreCase", "literal", "context"].filter((k) => op[k] !== undefined);
          if (unsupported.length > 0) {
            return {
              stdout: "",
              stderr: `grep: unsupported arg(s) in opencode adapter: ${unsupported.join(", ")} — use a shell grep instead`,
              exitCode: 1,
            };
          }
          const scoped = scopeDir(op.path, "grep");
          if (scoped.err) return scoped.err;
          const r = await client.find.text({ query: { pattern, directory: scoped.dir } });
          if (r.error) return fail(`grep ${pattern}`, r.error);
          const matches = sliceLimit(r.data ?? [], op.limit);
          const stdout = matches.map((m) => `${m.path.text}:${m.line_number}:${m.lines.text}`).join("\n");
          return { stdout, stderr: "", exitCode: stdout ? 0 : 1 };
        }
        case "find": {
          const pattern = String(op.pattern ?? "");
          const scoped = scopeDir(op.path, "find");
          if (scoped.err) return scoped.err;
          const r = await client.find.files({ query: { query: pattern, directory: scoped.dir } });
          if (r.error) return fail(`find ${pattern}`, r.error);
          const stdout = sliceLimit(r.data ?? [], op.limit).join("\n");
          return { stdout, stderr: "", exitCode: stdout ? 0 : 1 };
        }
        case "ls": {
          const path = String(op.path ?? ".");
          const gone = missing(path);
          if (gone) return gone;
          const r = await client.file.list({ query: { path, directory } });
          if (r.error) return fail(`ls ${path}`, r.error);
          const entries = sliceLimit(r.data ?? [], op.limit);
          const stdout = entries.map((n) => n.name ?? n.path ?? "").filter(Boolean).join("\n");
          return { stdout, stderr: "", exitCode: 0 };
        }
        default:
          return { stdout: "", stderr: `unknown tool: ${op.tool}`, exitCode: 1 };
      }
    } catch (err) {
      return fail(String(op.tool), err);
    }
  };
}

export const server: Plugin = async ({ client }) => ({
  tool: {
    predexec: {
      description: DESCRIPTION,
      args: {
        plan: z.any().describe(
          'Plan tree object: {root, nodes:[{id, commands:[<shell string> | {tool:"read",path,offset?,limit?} | {tool:"grep",pattern,path?} | {tool:"find",pattern,path?} | {tool:"ls",path?}], parallel?, edges?:[{when,to}]}], cwd?, maxDepth?}. ' +
          'when: "always" | "exit == 0" (ops ==,!=,<,>) | "stdout =~ /regex/" (also stderr, !~) | "file exists <path>" / "file missing <path>", or a {kind,...} condition object. ' +
          "Note: grep/find scope by a directory `path` (grep glob/ignoreCase/literal/context are unsupported here and error loudly); read offset/limit and grep/find/ls `limit` are applied client-side.",
        ),
      },
      async execute(args: { plan: unknown }, context: ToolContext) {
        let plan: PlanTree;
        try {
          plan = coercePlan(args.plan);
        } catch (err) {
          return (err as Error).message;
        }

        const executeToolOp = createToolExecutor(client as unknown as OpencodeClient, context.directory);
        // Re-read per call (one small JSON read): config edits apply immediately,
        // and an unconfigured host costs a cheap no-op checker.
        const checkCommandPolicy = createPolicyChecker(readOpencodeBashRules(context.directory));

        const result = await runPlanTree(plan, {
          cwd: context.directory,
          signal: context.abort,
          executeToolOp,
          checkCommandPolicy,
        });

        void recordRun(plan, result, "opencode");

        return result.transcript || "(no output)";
      },
    },
  },

  // opencode has no native plugin-skill loader (unlike pi's `pi.skills`), so we
  // inject the routing line here — but only as a guarded fallback. When the host
  // already carries the rule (e.g. a project AGENTS.md/CLAUDE.md with the same
  // block — see configs/opencode/AGENTS.md), we stay silent to avoid duplication.
  "experimental.chat.system.transform": async (_input, output) => {
    if (!systemHasRoutingInstructions(output.system)) {
      output.system.push(STEERING_LINE);
    }
  },

  "tool.execute.after": async (input, output) => {
    const nudge = '[predexec] Batch read-only commands in one predexec call: {"root":"a","nodes":[{"id":"a","commands":["cmd1","cmd2"],"parallel":true}]}\n';
    if (["read", "grep", "glob"].includes(input.tool)) {
      output.output = nudge + output.output;
    } else if (input.tool === "bash") {
      const cmd = input.args?.command ?? "";
      if (cmd && !isDestructiveCommand(cmd)) {
        output.output = nudge + output.output;
      }
    }
  },
});

// What current opencode loaders (readV1Plugin) actually read; the named
// `server` export above serves older hosts that iterate named exports.
export default { id: "predexec", server };
