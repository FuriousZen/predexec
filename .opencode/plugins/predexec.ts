/**
 * predexec — opencode adapter (read-only MVP).
 *
 * Registers ONE tool, `predexec`, that runs a pre-planned tree of command
 * batches with deterministic branch conditions in a single model round-trip.
 * All real logic lives in ../../core, entered through ../../adapter-runtime.ts;
 * both are pure TS, zero harness imports.
 *
 * Native tool ops (read/grep/find/ls) are wired to opencode's v1 SDK client
 * (file.read / find.text / find.files / file.list). Caveats vs pi: file.read
 * has no offset/limit (sliced client-side), and find.text (grep) is
 * directory-scoped with no glob.
 *
 * Export shape: opencode's plugin loader (readV1Plugin, ≥1.17.x) reads ONLY the
 * default export and requires `{ server() }` — see the bottom of this file.
 * Runtime imports are zod + our own modules only; `@opencode-ai/plugin` is not
 * a dependency at all (npm-installed plugins get production deps only, and the
 * host does not provide that package at import time) — the `Plugin`/`ToolContext`
 * shapes this file needs are declared locally below.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  isDestructiveCommand,
  type ToolOp,
  type ToolExecutor,
} from "../../core/index.ts";
import { executeAdapterPlan } from "../../adapter-runtime.ts";
import {
  BASH_NUDGE,
  DESCRIPTION_BASE,
  RECOVERY_LINE,
  STEERING_LINE,
  USAGE_LINE,
  VERIFY_FIRST_LINE,
  WHEN_SYNTAX_LINE,
  systemHasRoutingInstructions,
} from "../../steering.ts";
import { PLAN_SHAPE_DESCRIPTION } from "../../plan-language.ts";
// PLAN_SHAPE_DESCRIPTION includes JSON_PATH_SINGLE_OP_LINE for the plan argument.
import { createPolicyChecker, readOpencodeBashRules, readOpencodeOperationRules } from "../../policy.ts";

const DESCRIPTION =
  DESCRIPTION_BASE +
  USAGE_LINE +
  RECOVERY_LINE +
  "Shell and mapped file operations respect your opencode permission rules — deny/ask matches hard-stop before running. " +
  VERIFY_FIRST_LINE;

/**
 * Local structural stand-ins for the `@opencode-ai/plugin` types this file
 * touches: the plugin factory's `client` input, the `directory`/`abort`
 * fields of `ToolContext`, and the three hook keys this plugin returns.
 * `@opencode-ai/plugin` is not imported at all — see the file header — so
 * these cover only what this adapter actually uses, not the full host contract.
 */
type PluginToolContext = { directory: string; abort: AbortSignal };

type PluginHooks = {
  tool: {
    predexec: {
      description: string;
      args: Record<string, unknown>;
      execute(args: { plan: unknown }, context: PluginToolContext): Promise<string>;
    };
  };
  "experimental.chat.system.transform": (
    input: unknown,
    output: { system: string[] },
  ) => Promise<void>;
  "tool.execute.after": (
    input: { tool: string; args?: { command?: string } },
    output: { output: string },
  ) => Promise<void>;
};

type Plugin = (input: { client: unknown }) => Promise<PluginHooks>;

/** opencode v1 SDK client (the subset predexec calls). Loosely typed to avoid a hard SDK dep. */
type OpencodeClient = {
  file: {
    read(opts: { query: { path: string; directory?: string } }): Promise<{ data?: { content?: string }; error?: unknown }>;
    list(opts: { query: { path: string; directory?: string } }): Promise<{ data?: Array<{ name?: string; path?: string }>; error?: unknown }>;
  };
  find: {
    text(opts: { query: { pattern: string; directory?: string } }): Promise<{ data?: Array<{ path: { text: string }; lines: { text: string }; line_number: number }>; error?: unknown }>;
    files(opts: { query: { query: string; directory?: string; limit?: number } }): Promise<{ data?: string[]; error?: unknown }>;
  };
};

/**
 * opencode's /find (grep) endpoint passes a literal `limit: 10` to ripgrep and
 * accepts no override — measured against opencode 1.18.14. /find/file defaults
 * to 10 but honours an explicit `limit`.
 */
const OPENCODE_GREP_CAP = 10;
const DEFAULT_FIND_LIMIT = 100;

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
          let stdoutTruncated = false;
          // v1 file.read has no offset/limit — apply line-slicing client-side (offset is 1-based).
          if (typeof op.offset === "number" || typeof op.limit === "number") {
            const lines = content.split("\n");
            const start = Math.max(0, (typeof op.offset === "number" ? op.offset : 1) - 1);
            const end = typeof op.limit === "number" ? start + op.limit : lines.length;
            stdoutTruncated = end < lines.length;
            content = lines.slice(start, end).join("\n");
          }
          return { stdout: content, stderr: "", exitCode: 0, ...(stdoutTruncated ? { stdoutTruncated: true } : {}) };
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
          const raw = r.data ?? [];
          const matches = sliceLimit(raw, op.limit);
          const stdout = matches.map((m) => `${m.path.text}:${m.line_number}:${m.lines.text}`).join("\n");
          // opencode's /find endpoint hard-codes limit:10 server-side and takes
          // no limit parameter, so a hit count of exactly 10 is indistinguishable
          // from "truncated". Silent truncation feeding a match/numeric edge is
          // false-hit fuel, so say so instead of letting the model assume it saw
          // everything. Verified against opencode 1.18.14.
          // Only warn when the caller is actually seeing the cap: if they asked
          // for fewer than we got, they received exactly what they requested.
          const capped = raw.length >= OPENCODE_GREP_CAP && matches.length === raw.length;
          return {
            stdout,
            stderr: capped
              ? `grep: opencode caps results at ${OPENCODE_GREP_CAP} matches and cannot raise it — ` +
                `results may be incomplete; use a shell \`rg\`/\`grep\` for an exhaustive search`
              : "",
            exitCode: stdout ? 0 : 1,
            ...(capped ? { stdoutTruncated: true } : {}),
          };
        }
        case "find": {
          const pattern = String(op.pattern ?? "");
          const scoped = scopeDir(op.path, "find");
          if (scoped.err) return scoped.err;
          // The endpoint defaults to 10 results but DOES accept a limit — the
          // adapter previously omitted it and then sliced client-side, so every
          // find silently returned at most 10 regardless of op.limit.
          const limit = typeof op.limit === "number" && op.limit > 0 ? op.limit : DEFAULT_FIND_LIMIT;
          const r = await client.find.files({ query: { query: pattern, directory: scoped.dir, limit } });
          if (r.error) return fail(`find ${pattern}`, r.error);
          // Send the limit AND slice: the query limit stops the server capping
          // us at its default of 10, the slice keeps op.limit exact regardless
          // of how the server interprets it.
          const stdout = sliceLimit(r.data ?? [], op.limit).join("\n");
          const requested = typeof op.limit === "number" && op.limit >= 0 ? op.limit : undefined;
          const truncated = requested !== undefined && (r.data?.length ?? 0) > requested;
          return { stdout, stderr: "", exitCode: stdout ? 0 : 1, ...(truncated ? { stdoutTruncated: true } : {}) };
        }
        case "ls": {
          const path = String(op.path ?? ".");
          const gone = missing(path);
          if (gone) return gone;
          const r = await client.file.list({ query: { path, directory } });
          if (r.error) return fail(`ls ${path}`, r.error);
          const entries = sliceLimit(r.data ?? [], op.limit);
          const stdout = entries.map((n) => n.name ?? n.path ?? "").filter(Boolean).join("\n");
          const truncated = entries.length < (r.data?.length ?? 0);
          return { stdout, stderr: "", exitCode: 0, ...(truncated ? { stdoutTruncated: true } : {}) };
        }
        default:
          return { stdout: "", stderr: `unknown tool: ${op.tool}`, exitCode: 1 };
      }
    } catch (err) {
      return fail(String(op.tool), err);
    }
  };
}

const server: Plugin = async ({ client }) => ({
  tool: {
    predexec: {
      description: DESCRIPTION,
      args: {
        plan: z.any().describe(
          PLAN_SHAPE_DESCRIPTION +
          WHEN_SYNTAX_LINE +
          "Note: grep/find scope by a directory `path` (grep glob/ignoreCase/literal/context are unsupported here and error loudly); read offset/limit and grep/find/ls `limit` are applied client-side.",
        ),
      },
      async execute(args: { plan: unknown }, context: PluginToolContext) {
        const executeToolOp = createToolExecutor(client as unknown as OpencodeClient, context.directory);
        // Re-read per call (one small JSON read): config edits apply immediately,
        // and an unconfigured host costs a cheap no-op checker.
        const bashPolicy = readOpencodeBashRules(context.directory);
        const nativePolicy = readOpencodeOperationRules(context.directory);
        const checkBash = createPolicyChecker(bashPolicy.rules, bashPolicy.unreadable);
        const checkNative = createPolicyChecker(nativePolicy.rules, nativePolicy.unreadable);
        const checkOperationPolicy = (operation: import("../../core/types.ts").Operation) =>
          typeof operation === "string" || operation.tool === "bash" ? checkBash(operation) : checkNative(operation);

        const result = await executeAdapterPlan(args.plan, "opencode", {
          cwd: context.directory,
          signal: context.abort,
          executeToolOp,
          checkOperationPolicy,
        });

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
    const nudge = "\n" + BASH_NUDGE;
    if (["read", "grep", "glob"].includes(input.tool)) {
      output.output += nudge;
    } else if (input.tool === "bash") {
      const cmd = input.args?.command ?? "";
      if (cmd && !isDestructiveCommand(cmd)) {
        output.output += nudge;
      }
    }
  },
});

// What current opencode loaders (readV1Plugin) actually read: ONLY the
// default export's `{ id, server() }` shape. `server` above is intentionally
// not a named export — nothing in this codebase's supported loader path reads
// it that way (see the file header), and tests reach it through this default
// export (`plugin.server`).
export default { id: "predexec", server };
