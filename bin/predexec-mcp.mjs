#!/usr/bin/env node
/**
 * predexec-mcp — launcher for the Claude Code (MCP) stdio server.
 *
 * Thin on purpose: the server lives in ../mcp/server.ts and nothing here does
 * more than load it and hand over. Plain JS on node builtins (like its
 * `predexec` sibling) so it can be a `bin` entry with no build step.
 *
 * WHY jiti RATHER THAN A PLAIN import(). The server is TypeScript, and this
 * launcher runs under plain `node` — pi's loader and opencode's Bun are not
 * here. Node's own type stripping cannot do it: it REFUSES files under
 * node_modules ("Stripping types is currently unsupported for files under
 * node_modules"), with no flag to override, and an npm/npx install is by
 * definition under node_modules. Measured against a packed tarball, not
 * assumed — the failure is invisible from a source checkout, where stripping
 * works fine. jiti is the same loader pi uses, so this stays the project's one
 * TS-loading pattern rather than a new build step.
 *
 * STDOUT IS THE PROTOCOL — every diagnostic below goes to stderr. A single line
 * of chatter on stdout corrupts the JSON-RPC frame stream and surfaces to the
 * user as an unrelated parse error, so there is no console.log in this file and
 * `main()` rebinds the global console to stderr before it connects.
 */

import { isDirectInvocation } from "./predexec.mjs";

/** Resolved from this file, so a symlinked bin still finds the source. */
const SERVER_URL = new URL("../mcp/server.ts", import.meta.url);

export async function launch() {
  let jiti;
  try {
    const { createJiti } = await import("jiti");
    // Anchored at this file so jiti resolves the server's imports (core, zod,
    // the MCP SDK) exactly as node would from inside the package.
    jiti = createJiti(import.meta.url);
  } catch (err) {
    console.error(
      `predexec-mcp: cannot load the TypeScript loader (${err?.message ?? err}) — ` +
        "the install is incomplete; reinstall predexec (`npm i predexec`) or clear the npx cache and retry.",
    );
    process.exitCode = 1;
    return;
  }

  let server;
  try {
    server = await jiti.import(SERVER_URL.href);
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
