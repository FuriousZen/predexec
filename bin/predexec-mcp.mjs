#!/usr/bin/env node
/**
 * predexec-mcp — launcher for the Claude Code (MCP) stdio server.
 *
 * Thin on purpose: loads the compiled server from ../dist/mcp/server.js and
 * hands over. Plain JS on node builtins with no dynamic loader required.
 *
 * STDOUT IS THE PROTOCOL — every diagnostic below goes to stderr. A single line
 * of chatter on stdout corrupts the JSON-RPC frame stream and surfaces to the
 * user as an unrelated parse error, so there is no console.log in this file and
 * `main()` rebinds the global console to stderr before it connects.
 */

import { isDirectInvocation } from "./predexec.mjs";

/** Resolved from this file, so a symlinked bin still finds the compiled entry. */
const SERVER_URL = new URL("../dist/mcp/server.js", import.meta.url);

export async function launch() {
  let server;
  try {
    server = await import(SERVER_URL.href);
  } catch (err) {
    console.error(`predexec-mcp: failed to load ${SERVER_URL.pathname}: ${err?.message ?? err}`);
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
