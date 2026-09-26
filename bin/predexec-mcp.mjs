#!/usr/bin/env node
/**
 * predexec-mcp — launcher for the Claude Code (MCP) stdio server.
 *
 * Thin on purpose: loads the compiled server from ../dist/mcp/server.js and
 * hands over. Plain JS on node builtins with no dynamic loader required.
 *
 * STDOUT IS THE PROTOCOL — every diagnostic below goes to stderr. A single line
 * of chatter on stdout corrupts the JSON-RPC frame stream and surfaces to the
 * user as an unrelated parse error, so there is no console.log in this file.
 * The global console is rebound to stderr at the TOP of this file, before the
 * server module — loaded via the DYNAMIC `import()` in launch() below, which
 * pulls in the MCP SDK — is ever evaluated: import-time logging from that
 * dependency graph would otherwise land on stdout unguarded, since `main()`'s
 * own rebind (see mcp/server.ts's silenceStdout()) runs too late to cover
 * module init. This ordering guarantee covers only that dynamic import, NOT
 * `./predexec.mjs` below: ESM evaluates a static import's target module
 * before any of the importing module's own top-level statements, so
 * `./predexec.mjs` actually runs before this rebind regardless of where the
 * `import` line sits textually. It is safe today only because that module is
 * plain node-builtins-only code with no top-level output (verified) — it
 * must stay that way, or gain its own guard, for this guarantee to hold.
 *
 * `--host claude-code|codex|antigravity` (also `--host=codex`) selects the
 * policy adapter and stats label downstream in mcp/server.ts; default stays
 * "claude-code" so an existing install with no flag is byte-for-byte unchanged.
 * `--root <dir>` (antigravity only) names the session root: agy starts a
 * workspace server in its launch dir and a plugin server in the plugin dir,
 * so cwd is not always the workspace (docs/research/antigravity.md §a). Codex clears
 * the subprocess env before spawning an MCP server (measured — no `CODEX_*`
 * marker reaches us), so host detection is impossible and the registration
 * command must declare it explicitly. parseHostArg() rejects an unrecognized
 * value BEFORE the server module (and any transport) is ever touched, so that
 * failure always lands on stderr with nothing on stdout first.
 */

// stdio MCP: stdout carries protocol frames only. Rebind BEFORE launch()'s
// dynamic `import(SERVER_URL.href)` runs, so import-time logging from the
// server graph (the MCP SDK included) lands on stderr — silenceStdout()
// inside main() runs too late to guard that module's init. Static imports in
// this file (`./predexec.mjs`, immediately below) are NOT covered by this
// ordering: ESM evaluates their top-level code before this rebind executes,
// import position notwithstanding — they must stay free of top-level output.
import { Console } from "node:console";
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

import { isDirectInvocation } from "./predexec.mjs";

/** Resolved from this file, so a symlinked bin still finds the compiled entry. */
const SERVER_URL = new URL("../dist/mcp/server.js", import.meta.url);

const VALID_HOSTS = new Set(["claude-code", "codex", "antigravity"]);
const USAGE = "usage: predexec-mcp [--host claude-code|codex|antigravity] [--root <dir>]";

/**
 * Parse `--host <value>` / `--host=<value>` out of `argv`, stripping it
 * before anything else looks at argv (there is nothing else to look at
 * today, but that is the contract). Returns `{ host }`, defaulting to
 * "claude-code" when the flag is absent — zero behavior change for every
 * existing registration. Throws a plain `Error` (message is usage-ready for
 * stderr) on an unrecognized value; the caller must handle that BEFORE
 * touching the server module, so an invalid flag never gets far enough to
 * write anything to stdout.
 */
export function parseHostArg(argv) {
  let host = "claude-code";
  let root;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host") host = argv[++i];
    else if (arg.startsWith("--host=")) host = arg.slice("--host=".length);
    else if (arg === "--root") root = argv[++i] ?? "";
    else if (arg.startsWith("--root=")) root = arg.slice("--root=".length);
  }
  if (!VALID_HOSTS.has(host)) {
    throw new Error(`predexec-mcp: invalid --host "${host}" (expected "claude-code", "codex" or "antigravity")\n${USAGE}`);
  }
  if (root !== undefined) {
    // Claude Code and Codex start the server in the session dir; a --root
    // there would be silently ignored, so refuse it instead.
    if (host !== "antigravity") throw new Error(`predexec-mcp: --root is only supported with --host antigravity\n${USAGE}`);
    if (!root) throw new Error(`predexec-mcp: --root needs a directory\n${USAGE}`);
    return { host, root };
  }
  return { host };
}

export async function launch(argv = process.argv.slice(2)) {
  let host;
  let root;
  try {
    ({ host, root } = parseHostArg(argv));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  let server;
  try {
    server = await import(SERVER_URL.href);
  } catch (err) {
    let message = `predexec-mcp: failed to load ${SERVER_URL.pathname}: ${err?.message ?? err}`;
    // A dev checkout never commits dist/ (see CLAUDE.md), so this is the one
    // failure mode a contributor hits routinely rather than a real install
    // bug — point at the fix instead of leaving them to guess at a bare
    // ERR_MODULE_NOT_FOUND.
    if (err?.code === "ERR_MODULE_NOT_FOUND" && err?.url === SERVER_URL.href) {
      message += ` dist/ is not checked in — run "npm run build" in the predexec checkout first.`;
    }
    console.error(message);
    process.exitCode = 1;
    return;
  }

  try {
    await server.main(root === undefined ? { host } : { host, root });
  } catch (err) {
    // Reaching here means the transport never came up; the client sees an
    // immediate exit, so the reason has to be on stderr for it to be logged.
    console.error(`predexec-mcp: could not start the stdio server: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

// `isDirectInvocation`'s moduleUrl default is evaluated in predexec.mjs's scope,
// so it MUST be passed explicitly here — calling it bare compares that file's
// URL against argv[1] and is always false, which is the same silent no-op the
// realpath fix was written to kill.
if (isDirectInvocation(import.meta.url)) {
  await launch();
}
