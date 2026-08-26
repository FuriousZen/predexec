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

export async function launch() {
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
    await server.main();
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
