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
 *
 * Permissions (opencode-only behavior change): when opencode hands the tool
 * `context.ask` — its real permission service (`@opencode-ai/plugin@1.18.32`
 * `src/tool.ts:19`, bridged in opencode `tool/registry.ts:143-153`) — every
 * operation's permission request goes through it, so a rule that says `ask`
 * now makes opencode PROMPT the user mid-walk instead of hard-stopping the
 * plan. Approval (once or always) runs the operation; a rejection or a host
 * deny is a policyStop naming opencode's reason. The static reader in
 * ../../policy.ts still runs first: a static `deny` stops at once without a
 * prompt. Without `context.ask` (older hosts) the static reader is the whole
 * check and both deny and ask hard-stop, as before. Claude Code, Codex and pi
 * cannot prompt mid-walk and keep hard-stopping on ask.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  isDestructiveCommand,
  validateOperation,
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
import { createOpencodeAskBridge, createPolicyChecker, readOpencodeRuleset, type OpencodeAsk } from "../../policy.ts";

const DESCRIPTION =
  DESCRIPTION_BASE +
  USAGE_LINE +
  RECOVERY_LINE +
  "Shell and mapped file operations respect your opencode permission rules — a deny stops before running; an ask prompts through opencode when it can, else stops. " +
  VERIFY_FIRST_LINE;

/**
 * Local structural stand-ins for the `@opencode-ai/plugin` types this file
 * touches: the plugin factory's `client` input, the `directory`/`worktree`/
 * `agent`/`abort`/`ask` fields of `ToolContext` (`src/tool.ts:3-27` in
 * `@opencode-ai/plugin@1.18.32`; `ask` resolves on approval and rejects on
 * deny/reject), and the three hook keys this plugin returns.
 * `@opencode-ai/plugin` is not imported at all — see the file header — so
 * these cover only what this adapter actually uses, not the full host contract.
 */
type PluginToolContext = {
  directory: string;
  abort: AbortSignal;
  /** Optional so older hosts and bare test contexts still work. */
  worktree?: string;
  agent?: string;
  ask?: OpencodeAsk;
};

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
    read(opts: {
      query: { path: string; directory?: string };
    }): Promise<{ data?: { type?: "text" | "binary"; content?: string }; error?: unknown }>;
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
 * to 10 but honours an explicit `limit`, bounded 1..200 server-side
 * (`FindFileQuery.limit`, opencode 1.18.32
 * packages/opencode/src/server/routes/instance/httpapi/groups/file.ts:27-32 —
 * `Schema.NumberFromString.check(..., Schema.isLessThanOrEqualTo(200))`); a
 * raw request above 200 is rejected outright, not clamped.
 */
const OPENCODE_GREP_CAP = 10;
const DEFAULT_FIND_LIMIT = 100;
const OPENCODE_FIND_CEILING = 200;

/**
 * True when `relPath` (POSIX-relative to the session root) sits at or under
 * `prefix` (also POSIX-relative, no trailing slash, "" meaning "no scope").
 */
function withinPrefix(relPath: string, prefix: string): boolean {
  if (!prefix) return true;
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return p === prefix || p.startsWith(prefix + "/");
}

/** Separator-aware containment: `/root2` is never "within" `/root`. */
function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

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
    // "Never ran" (invalid arg, unknown tool, an SDK error/throw, a rejected
    // find limit, a binary read) is exit 2; a search that ran and found
    // nothing stays exit 1 — the same split mcp/tool-ops.ts uses for grep/find,
    // generalized here to every op so a validation failure can never be read
    // as "ran, found nothing" on any of them.
    const NEVER_RAN = 2;
    const fail = (label: string, e: unknown) => ({ stdout: "", stderr: `${label}: ${errText(e)}`, exitCode: NEVER_RAN });
    const requiredArgMissing =
      (op.tool === "read" && op.path === undefined) ||
      ((op.tool === "grep" || op.tool === "find") && op.pattern === undefined);
    const supportedTool = ["read", "grep", "find", "ls", "bash", "edit", "write"].includes(op.tool);
    const validationError = supportedTool && !requiredArgMissing ? validateOperation(op) : null;
    if (validationError) return fail(String(op.tool), `invalid operation: ${validationError}`);
    // grep/find always query the SESSION ROOT — never a subdirectory. opencode's
    // workspace-routing middleware keys instance selection off this exact
    // `directory` query param (defaultDirectory(), middleware/workspace-routing.ts:87
    // in opencode 1.18.32: `url.searchParams.get("directory") || ... || process.cwd()`),
    // so sending a resolved subdirectory here would risk booting/routing to a
    // DIFFERENT opencode instance per subdirectory (config/plugins/LSP reload)
    // instead of merely narrowing the search. A `path` arg is honored instead
    // by computing a POSIX-relative prefix and filtering the root-wide SDK
    // response client-side (see withinPrefix above); a FILE path still fails
    // loudly — the silent alternative (searching the whole repo) is false-hit
    // fuel for edges.
    const scopeDir = (
      p: unknown,
      tool: string,
    ): { prefix: string; err?: undefined } | { prefix?: undefined; err: { stdout: string; stderr: string; exitCode: number } } => {
      if (p === undefined) return { prefix: "" };
      const path = String(p);
      const gone = missing(path);
      if (gone) return { err: { ...gone, exitCode: NEVER_RAN } };
      const abs = isAbsolute(path) ? path : resolve(directory, path);
      // A path that exists but resolves outside the session root (an
      // absolute path elsewhere, or `..` walking past the root) must refuse
      // explicitly. Silently letting it through would either search the
      // whole root and report a false "no matches" (withinPrefix can never
      // match a `..`-laden prefix against the SDK's root-relative paths), or
      // reintroduce the exact cross-instance routing risk OC-6 fixed.
      //
      // Lexical containment alone is wrong two ways: a session root and an
      // absolute path can each be spelled through a DIFFERENT alias of the
      // SAME real directory (macOS's /var vs /private/var, or any symlinked
      // root) and lexically mismatch despite being identical on disk; and a
      // path that lexically sits inside the root can still escape it through
      // a symlinked intermediate directory. realpath is checked whenever
      // it's resolvable (existence was already confirmed above, via
      // `missing()`) and is authoritative when available — mirrors
      // mcp/tool-ops.ts's `locate()`/`target()` two-pass containment. The
      // lexical result is only a fallback for the (here, essentially
      // unreachable) case where realpath itself can't be resolved.
      const realRoot = realpathOrNull(directory);
      const realAbs = realpathOrNull(abs);
      const withinReal = realRoot !== null && realAbs !== null ? isWithin(realRoot, realAbs) : null;
      const outside = withinReal !== null ? !withinReal : !isWithin(directory, abs);
      if (outside) {
        return {
          err: {
            stdout: "",
            stderr: `${tool}: "${path}" resolves outside session root (${directory}) — refusing to scope there`,
            exitCode: NEVER_RAN,
          },
        };
      }
      try {
        if (!statSync(abs).isDirectory()) {
          return {
            err: {
              stdout: "",
              stderr: `${tool}: opencode can only scope by directory; "${path}" is a file — use a shell command for single files`,
              exitCode: NEVER_RAN,
            },
          };
        }
      } catch {
        /* stat raced away; missing() already vetted existence */
      }
      // Compute the prefix from whichever pair of forms actually agreed above
      // — mixing a lexical root with a realpath target (or vice versa) would
      // produce a nonsense `relative()` full of `..` segments when the two
      // inputs were spelled through different aliases.
      const prefix =
        realRoot !== null && realAbs !== null
          ? relative(realRoot, realAbs).split(sep).join("/")
          : relative(directory, abs).split(sep).join("/");
      return { prefix: prefix === "." ? "" : prefix };
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
          // v1 file.read returns { type: "binary", content: <base64>, ... } for
          // any file whose bytes don't decode as UTF-8 (handlers/file.ts:113-119
          // in opencode 1.18.32). An MCP-style text result cannot carry that
          // usefully, and treating the base64 blob as text would poison every
          // regex condition downstream — refuse loudly instead.
          if (r.data?.type === "binary") {
            return { stdout: "", stderr: `read ${path}: binary file — this adapter reads text only`, exitCode: NEVER_RAN };
          }
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
              exitCode: NEVER_RAN,
            };
          }
          const scoped = scopeDir(op.path, "grep");
          if (scoped.err) return scoped.err;
          const r = await client.find.text({ query: { pattern, directory } });
          if (r.error) return fail(`grep ${pattern}`, r.error);
          const raw = r.data ?? [];
          // `directory` above is always the session root (never scoped.prefix's
          // resolved path — see scopeDir's comment), so a `path` arg is applied
          // by filtering the root-wide response to that prefix instead.
          const scopedRaw = scoped.prefix ? raw.filter((m) => withinPrefix(m.path.text, scoped.prefix)) : raw;
          const matches = sliceLimit(scopedRaw, op.limit);
          const stdout = matches.map((m) => `${m.path.text}:${m.line_number}:${m.lines.text}`).join("\n");
          const callerCapped = scopedRaw.length > matches.length;
          // opencode's /find endpoint hard-codes limit:10 server-side and takes
          // no limit parameter, so a hit count of exactly 10 is indistinguishable
          // from "truncated". Silent truncation feeding a match/numeric edge is
          // false-hit fuel, so say so instead of letting the model assume it saw
          // everything. Verified against opencode 1.18.14. The cap applies to the
          // RAW (unscoped) response — a `path` prefix can only ever narrow what
          // survived that root-wide cap, so a full ten-row raw page is a warning
          // sign regardless of how many rows the prefix filter kept.
          const hostCapped = raw.length >= OPENCODE_GREP_CAP;
          // A scoped search that came back empty while the ROOT-WIDE cap was
          // hit never actually got far enough to certify "no matches in
          // scope" — that's not "ran, found nothing" (1), it's "didn't cover
          // the scope" (2), so a HIGH_CONFIDENCE `exitCode` edge can't read
          // it as a confirmed miss.
          if (scoped.prefix && matches.length === 0 && hostCapped) {
            return {
              stdout: "",
              stderr:
                `grep: opencode's ${OPENCODE_GREP_CAP}-match cap on the whole session root was reached before any ` +
                `results under "${scoped.prefix}" were found — the search did not cover this directory; narrow ` +
                `further or use a shell \`rg\`/\`grep\` scoped to the directory`,
              exitCode: NEVER_RAN,
            };
          }
          const notes: string[] = [];
          if (callerCapped) {
            notes.push(`grep: caller limit ${String(op.limit)} reached — results may be incomplete; use a larger limit or narrow the pattern`);
          }
          if (hostCapped) {
            notes.push(
              scoped.prefix
                ? `grep: opencode caps results at ${OPENCODE_GREP_CAP} matches searched across the whole session root ` +
                  `(directory scoping is applied client-side) — matches under "${scoped.prefix}" may be crowded out by ` +
                  `matches elsewhere; use a shell \`rg\`/\`grep\` scoped to the directory for an exhaustive search`
                : `grep: opencode caps results at ${OPENCODE_GREP_CAP} matches and cannot raise it — ` +
                  `results may be incomplete; use a shell \`rg\`/\`grep\` for an exhaustive search`,
            );
          }
          return {
            stdout,
            stderr: notes.join(" "),
            exitCode: stdout ? 0 : 1,
            ...(callerCapped || hostCapped ? { stdoutTruncated: true } : {}),
          };
        }
        case "find": {
          const pattern = String(op.pattern ?? "");
          const scoped = scopeDir(op.path, "find");
          if (scoped.err) return scoped.err;
          // The endpoint defaults to 10 results but DOES accept a limit — the
          // adapter previously omitted it and then sliced client-side, so every
          // find silently returned at most 10 regardless of op.limit. It also
          // REJECTS (not clamps) anything above 200 (OPENCODE_FIND_CEILING), so
          // the effective ask is capped there before it ever reaches the SDK.
          const requestedLimit = typeof op.limit === "number" && op.limit > 0 ? op.limit : DEFAULT_FIND_LIMIT;
          const effectiveLimit = Math.min(requestedLimit, OPENCODE_FIND_CEILING);
          // Peek one row past what's needed so a full page reads as "exactly
          // enough" vs. "truncated" — but never past the server's own ceiling:
          // asking for 201 when the ceiling is 200 gets the WHOLE request
          // rejected, not clamped.
          const probeLimit = Math.min(effectiveLimit + 1, OPENCODE_FIND_CEILING);
          const r = await client.find.files({ query: { query: pattern, directory, limit: probeLimit } });
          if (r.error) return fail(`find ${pattern}`, r.error);
          const raw = r.data ?? [];
          // `directory` above is always the session root — a `path` arg is
          // applied by filtering the root-wide response to its prefix, same as grep.
          const filtered = scoped.prefix ? raw.filter((p) => withinPrefix(p, scoped.prefix)) : raw;
          const results = filtered.slice(0, effectiveLimit);
          const stdout = results.join("\n");
          // A scoped search that came back empty while the ROOT-WIDE fetch
          // itself was already full never actually got far enough to certify
          // "no matches in scope" — exit 2 ("didn't cover the scope"), not
          // exit 1 ("ran, found nothing"), so a HIGH_CONFIDENCE `exitCode`
          // edge can't read it as a confirmed miss.
          if (scoped.prefix && results.length === 0 && raw.length >= probeLimit) {
            return {
              stdout: "",
              stderr:
                `find: opencode's root-wide fetch (${probeLimit} rows) was already full before any results under ` +
                `"${scoped.prefix}" were found — the search did not cover this directory; narrow the pattern or path`,
              exitCode: NEVER_RAN,
            };
          }
          const probedMore = filtered.length > effectiveLimit;
          const ceilingHit = requestedLimit > OPENCODE_FIND_CEILING;
          // The peek can never see past the ceiling itself, so a full page
          // AT the ceiling is inherently ambiguous — indistinguishable from
          // "exactly this many exist" — regardless of what was requested or
          // whether a `path` scope is active. Mirrors grep's unconditional
          // `hostCapped` (no scope gate) above.
          const atCeiling = raw.length >= OPENCODE_FIND_CEILING;
          // A `path` scope can only ever narrow a root-wide fetch; if that fetch
          // itself came back full, matches under the scope may have been pushed
          // out of the fetched window entirely — flag it, don't guess quietly.
          const scopeMayUndercount = Boolean(scoped.prefix) && raw.length >= probeLimit;
          const notes: string[] = [];
          if (ceilingHit) {
            notes.push(
              `find: opencode's server caps results at ${OPENCODE_FIND_CEILING} per request — asked for ${requestedLimit}; results are truncated`,
            );
          } else if (probedMore) {
            // A real peeked-extra-row: a DEFINITE fact, not a guess.
            notes.push(
              `find: more than ${effectiveLimit} matches exist — results are truncated; narrow the pattern or path, or raise limit up to ${OPENCODE_FIND_CEILING}`,
            );
          } else if (atCeiling) {
            notes.push(
              `find: opencode caps results at ${OPENCODE_FIND_CEILING} per request — results may be truncated at ` +
                `opencode's ${OPENCODE_FIND_CEILING}-result ceiling; narrow the pattern or path`,
            );
          }
          if (scopeMayUndercount) {
            notes.push(
              `find: "${String(op.path)}" scoping is applied client-side after a root-wide search — matches outside the fetched window may be missing`,
            );
          }
          const truncated = ceilingHit || probedMore || atCeiling || scopeMayUndercount;
          return { stdout, stderr: notes.join(" "), exitCode: stdout ? 0 : 1, ...(truncated ? { stdoutTruncated: true } : {}) };
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
          return { stdout: "", stderr: `unknown tool: ${op.tool}`, exitCode: NEVER_RAN };
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
          "Note: grep/find scope by a directory `path`, filtered client-side against the session root (grep glob/ignoreCase/literal/context are unsupported here and error loudly); find is capped at 200 results per call; read offset/limit and grep/find/ls `limit` are applied client-side.",
        ),
      },
      async execute(args: { plan: unknown }, context: PluginToolContext) {
        const executeToolOp = createToolExecutor(client as unknown as OpencodeClient, context.directory);
        // Re-read per call (a few small JSON reads): config edits apply
        // immediately. One bridge per call = one walk, so its dedupe and
        // stop-after-rejection state never leaks across tool calls.
        const worktree = typeof context.worktree === "string" ? context.worktree : undefined;
        const ruleset = readOpencodeRuleset(context.directory, process.env, {
          ...(typeof context.agent === "string" ? { agent: context.agent } : {}),
          ...(worktree ? { worktree } : {}),
        });
        const checkerOptions = { directory: context.directory, ...(worktree ? { worktree } : {}) };
        const ask = typeof context.ask === "function" ? context.ask.bind(context) : undefined;
        const checkOperationPolicy = ask
          ? createOpencodeAskBridge(ask, ruleset, { ...checkerOptions, signal: context.abort })
          : createPolicyChecker(ruleset, checkerOptions);

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
  //
  // opencode 1.18.32 fires this hook from exactly two call sites, and their
  // payloads are the only signal available to tell them apart:
  //  - session/llm/request.ts:56-72 (`prepare()`) triggers with
  //    `{ sessionID: input.sessionID, model: input.model }` for every chat
  //    turn — INCLUDING in-session "small" completions such as title
  //    generation (session/prompt.ts's `small: true` stream), which still
  //    carry the conversation's real sessionID. The documented hook input type
  //    (`{ sessionID?: string; model: Model }`, packages/plugin/src/index.ts:292)
  //    exposes nothing else to single those small completions out.
  //  - agent/agent.ts:381 (`Agent.generate`) triggers with `{ model: resolved }`
  //    and NO `sessionID` — a one-shot utility completion that synthesizes a
  //    brand-new agent config from a text description and is told to "Return
  //    ONLY the JSON object, no other text." There is no session for predexec
  //    routing to matter here, and injected prose risks corrupting that strict
  //    output contract.
  // `sessionID` presence is therefore the only reliable no-op signal: it
  // silences the sessionID-less Agent.generate path, but a real chat session's
  // own small/title completions are not (and, per this payload shape, cannot
  // be) distinguished from a full turn.
  "experimental.chat.system.transform": async (input, output) => {
    const sessionID = (input as { sessionID?: unknown } | null | undefined)?.sessionID;
    if (typeof sessionID !== "string" || sessionID === "") return;
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
