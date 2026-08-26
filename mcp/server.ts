/**
 * predexec — Claude Code (MCP) adapter: the stdio server.
 *
 * Registers ONE tool, `predexec`, that runs a pre-planned tree of command
 * batches with deterministic branch conditions in a single model round-trip.
 * All real logic lives in ../core (pure TS, zero harness imports); this file
 * only wires the MCP boundary: schema → coercePlan → runPlanTree → transcript.
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
import { STEERING_LINE, VERIFY_FIRST_LINE } from "../steering.ts";
import { createClaudePolicyChecker, readClaudeBashRules, type ClaudePolicyOptions } from "./policy-claude.ts";
import { createToolExecutor } from "./tool-ops.ts";

/** The tool name clients see as `mcp__predexec__predexec`. */
export const TOOL_NAME = "predexec";

/**
 * The tool description is the ONLY always-on steering channel here: an MCP
 * server has no system-prompt hook (pi loads a skill, opencode pushes a line),
 * so STEERING_LINE rides along with it. Everything but the permission sentence
 * is shared prose from ../steering.ts, so the three harnesses cannot drift.
 */
export const DESCRIPTION =
  "Run read-only shell commands and tool calls with deterministic branching. " +
  "Each node runs shell commands (strings) and/or tool calls ({tool, ...args}) sequentially or concurrently (parallel:true). " +
  "Edges evaluate conditions on output to choose the next node with no model call between levels. " +
  "Use parallel:true for independent reads, cwd for a shared base dir, and edges to branch. " +
  "mutationStop/noEdgeMatch is recoverable — read the transcript and resume with bash. Never retry the same plan blindly. " +
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
export const PLAN_ARG_DESCRIPTION =
  'Plan tree object: {root, nodes:[{id, commands:[<shell string> | {tool:"read",path,offset?,limit?} | ' +
  '{tool:"grep",pattern,path?,glob?,ignoreCase?,literal?,context?,limit?} | {tool:"find",pattern,path?,limit?} | ' +
  '{tool:"ls",path?,limit?}], parallel?, edges?:[{when,to}]}], cwd?, maxDepth?}. ' +
  'when: "always" | "exit == 0" (ops ==,!=,<,>) | "stdout =~ /regex/" (also stderr, !~) | ' +
  '"file exists <path>" / "file missing <path>", or a {kind,...} condition object. ' +
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
export function packageVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Run one plan and render it as a tool result.
 *
 * Coercion, unexpected errors, execution, and stats recording are all handled
 * by `executeAdapterPlan`. Validation and unexpected errors return a result
 * with `stoppedReason: "error"`, flagged as `isError: true` for the client.
 */
export async function runPredexecTool(
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
 */
export function silenceStdout(): void {
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
}

/** Start the stdio server. Called by bin/predexec-mcp.mjs; never at import time. */
export async function main(opts: PredexecServerOptions = {}): Promise<StdioServerHandle> {
  silenceStdout();
  return serveStdio(() => createServer(opts));
}
