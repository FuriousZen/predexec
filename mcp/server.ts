/**
 * predexec — Claude Code (MCP) adapter: the stdio server.
 *
 * Registers ONE tool, `predexec`, that runs a pre-planned tree of command
 * batches with deterministic branch conditions in a single model round-trip.
 * All real logic lives in ../core (pure TS, zero harness imports); this file
 * only wires the MCP boundary: schema → executeAdapterPlan (../adapter-runtime.ts:
 * coerce → run → record) → transcript.
 *
 * Claude Code exposes no in-process tool-registration API, so unlike the pi
 * extension and the opencode plugin this adapter is a SEPARATE PROCESS with no
 * host APIs at all. Two consequences shape the file:
 *
 *  1. Read/grep/find/ls come from ./tool-ops.ts (node:fs) rather than the host's
 *     own tool factories — a documented parity gap, not parity.
 *  2. The host's `Bash(...)` permission rules do not reach a subprocess, so
 *     ./policy-claude.ts reads Claude Code's settings itself and hard-stops via
 *     the engine's `policyStop` on any deny OR ask match. predexec is strictly
 *     more conservative than the host, never a permission-laundering path.
 *
 * STDOUT IS THE PROTOCOL. Under a stdio transport every byte on stdout must be
 * a JSON-RPC frame; one stray `console.log` corrupts the stream silently, and
 * the client reports a parse error rather than the log line. `main()` therefore
 * rebinds the global console to stderr before connecting — see silenceStdout().
 * Nothing here connects at import time, so importing this module (tests, the
 * launcher) never touches the runner's stdout.
 */

import { Console } from "node:console";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { ToolExecutor } from "../core/index.ts";
import { executeAdapterPlan } from "../adapter-runtime.ts";
import { DESCRIPTION_BASE, RECOVERY_LINE, STEERING_LINE, USAGE_LINE, VERIFY_FIRST_LINE, WHEN_SYNTAX_LINE } from "../steering.ts";
import { createClaudePolicyChecker, readClaudeBashRules, type ClaudePolicyOptions } from "./policy-claude.ts";
import { createToolExecutor } from "./tool-ops.ts";

/** The tool name clients see as `mcp__predexec__predexec`. */
export const TOOL_NAME = "predexec";

/**
 * The tool description is the ONLY always-on steering channel here: an MCP
 * server has no system-prompt hook (pi loads a skill, opencode pushes a line),
 * so STEERING_LINE rides along with it. DESCRIPTION composes shared prose from
 * ../steering.ts plus the harness-specific permission sentence below.
 */
export const DESCRIPTION =
  DESCRIPTION_BASE +
  USAGE_LINE +
  RECOVERY_LINE +
  "Shell commands are checked against your own Claude Code permission rules — a deny OR ask match hard-stops before running, " +
  "because predexec cannot prompt mid-walk. " +
  STEERING_LINE +
  " " +
  VERIFY_FIRST_LINE;

/**
 * Arg-level teaching, mirroring the opencode plugin's. The tool-op arg list is
 * this adapter's, not opencode's: ./tool-ops.ts implements read/grep/find/ls
 * itself, so offset/limit/glob/ignoreCase/literal/context are all honored here.
 */
const PLAN_ARG_DESCRIPTION =
  'Plan tree object: {root, nodes:[{id, commands:[<shell string> | {tool:"read",path,offset?,limit?} | ' +
  '{tool:"grep",pattern,path?,glob?,ignoreCase?,literal?,context?,limit?} | {tool:"find",pattern,path?,limit?} | ' +
  '{tool:"ls",path?,limit?}], parallel?, edges?:[{when,to}]}], cwd?, maxDepth?}. ' +
  WHEN_SYNTAX_LINE +
  "Note: tool ops read the filesystem directly (they are not Claude Code's native Read/Grep), " +
  "paths may not escape the session root, and grep/find fall back to a pure-Node walk that ignores .gitignore when ripgrep/fd are absent.";

/**
 * The MCP text result shape. Declared structurally so the SDK's types stay an
 * implementation detail; the index signature is what the SDK's own
 * `CallToolResult` requires (the protocol lets a result carry extra fields).
 */
interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface PredexecServerOptions {
  /**
   * Session root. An MCP server gets exactly one signal about where it is —
   * the directory Claude Code spawned it in — so process.cwd() is both the
   * tool-ops root and the project dir the permission rules are read from.
   */
  cwd?: string;
  /** Forwarded to the policy reader (env / managed-settings dir). Tests point it at fixtures. */
  policy?: ClaudePolicyOptions;
}

const textResult = (text: string, isError = false): ToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

/**
 * The package version, for the MCP `serverInfo` a client logs and displays.
 * Read from package.json rather than hard-coded so it cannot drift; a failure
 * to read it must not stop the server from starting, hence the fallback.
 */
function packageVersion(): string {
  // Two candidates because the module runs at two depths: mcp/ in the dev checkout, dist/mcp/ when compiled.
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const pkgPath = join(dirname(fileURLToPath(import.meta.url)), rel);
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return "0.0.0";
}

/**
 * Run one plan and render it as a tool result.
 *
 * Coercion, unexpected errors, execution, and stats recording are all handled
 * by `executeAdapterPlan`. Validation and unexpected errors return a result
 * with `stoppedReason: "error"`, flagged as `isError: true` for the client.
 */
async function runPredexecTool(
  rawPlan: unknown,
  opts: { cwd: string; executeToolOp: ToolExecutor; policy?: ClaudePolicyOptions; signal?: AbortSignal },
): Promise<ToolResult> {
  // Re-read the rules per call (a few small JSON reads): a permission edit
  // applies immediately, and an unconfigured host costs a cheap no-op checker.
  // The tool-ops root, by contrast, is fixed once at startup — it is the
  // session boundary, not a preference.
  const { rules, unreadable } = readClaudeBashRules(opts.cwd, opts.policy ?? {});
  const checkCommandPolicy = createClaudePolicyChecker(rules, unreadable);

  const result = await executeAdapterPlan(rawPlan, "claude-code", {
    cwd: opts.cwd,
    signal: opts.signal,
    executeToolOp: opts.executeToolOp,
    checkCommandPolicy,
  });

  // A validation or execution stop with reason "error" is an authoring/runtime error,
  // not a walk that ended early — flag it so the client renders it as a failed call.
  // mutationStop/policyStop/noEdgeMatch are ordinary, recoverable outcomes and stay non-error.
  return textResult(result.transcript || "(no output)", result.stoppedReason === "error");
}

/**
 * Build the MCP server with the single `predexec` tool registered.
 *
 * `z.unknown()` keeps the plan opaque at the boundary on purpose: coercePlan is
 * the validator, and it recovers double-encoded JSON and string shorthands that
 * a strict schema would reject before we ever saw them.
 */
export function createServer(opts: PredexecServerOptions = {}): McpServer {
  const cwd = resolve(opts.cwd ?? process.cwd());
  // Built once: PATH and the session root do not change mid-process, and the
  // rg/fd lookups inside are per-construction.
  const executeToolOp = createToolExecutor({ cwd });

  const server = new McpServer({ name: "predexec", version: packageVersion() });

  server.registerTool(
    TOOL_NAME,
    {
      description: DESCRIPTION,
      inputSchema: z.object({ plan: z.unknown().describe(PLAN_ARG_DESCRIPTION) }),
      // predexec is read-only speculation; any mutating node is a hard stop
      // BEFORE it runs (see the module doc). Declaring that here, not just in
      // prose, matters beyond Claude Code: Codex CLI's per-call approval mode
      // prompts on every call to a tool lacking `readOnlyHint: true`
      // (unannotated => destructive assumed), and also prompts if
      // `openWorldHint` is set — so it must stay absent, not just false.
      annotations: { readOnlyHint: true },
    },
    async (args, extra) =>
      runPredexecTool(args.plan, {
        cwd,
        executeToolOp,
        policy: opts.policy,
        // The client's cancellation reaches the walk, so an abandoned request
        // does not leave a subtree of commands running.
        signal: extra.mcpReq?.signal,
      }),
  );

  return server;
}

/**
 * Point every console method at stderr.
 *
 * A single `console.log` — ours, a dependency's, a future contributor's —
 * interleaves with the JSON-RPC frames on stdout and corrupts the session in a
 * way that surfaces as an unrelated parse error. Replacing the whole console
 * rather than patching `log` covers info/debug/dir/table/trace/group as well,
 * which is the difference between a convention and a guarantee.
 *
 * `bin/predexec-mcp.mjs` ALSO rebinds the console itself, at the top of the
 * file before the server module's DYNAMIC `import()` runs — that guards
 * import-time logging from the server graph (the MCP SDK included), which
 * executes before `main()` is ever called and so is out of reach from here.
 * (The launcher's own static imports are not covered by that guarantee and
 * must stay side-effect-free instead; see the comment there.) This copy
 * stays for embedded/`createServer`-only uses that bypass the launcher
 * entirely.
 */
function silenceStdout(): void {
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
}

/** Start the stdio server. Called by bin/predexec-mcp.mjs; never at import time. */
export async function main(opts: PredexecServerOptions = {}): Promise<StdioServerHandle> {
  silenceStdout();
  return serveStdio(() => createServer(opts), {
    onerror: (err) => console.error("predexec-mcp transport error:", err),
  });
}
