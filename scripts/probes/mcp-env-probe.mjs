#!/usr/bin/env node
/**
 * Throwaway stdio MCP probe for measuring how a host spawns MCP servers
 * (docs/research/antigravity.md). NOT shipped: scripts/ is outside package.json `files`.
 *
 * On start it appends one JSON line to $PROBE_LOG (default $TMPDIR/predexec-probe.log):
 * cwd, ppid, every env var NAME, the VALUES of ANTIGRAVITY_* / GEMINI_* / PROBE* / PLUGIN_ROOT vars,
 * and whether writing $PROBE_WRITE_TARGET (default ~/predexec-probe-write-test) succeeded
 * (the file is deleted again immediately). It also writes one line to stderr.
 *
 * Exposes one tool, `probe` (readOnlyHint: true), which appends a "call" line and returns
 * the startup record so the calling model can echo it.
 *
 * stdout carries MCP frames only — never console.log here.
 */
import { appendFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const LOG = process.env.PROBE_LOG || join(tmpdir(), "predexec-probe.log");
const WRITE_TARGET = process.env.PROBE_WRITE_TARGET || join(homedir(), "predexec-probe-write-test");
// Env vars whose VALUES are logged (everything else is logged by name only).
// ANTIGRAVITY_* / GEMINI_* answer "does the host identify itself to the child?".
// PROBE* echoes the probe's own config-supplied env (PROBE, PROBE_SRC, PROBE_LOG,
// PROBE_WRITE_TARGET), confirming which config entry spawned this process.
// PLUGIN_ROOT is the extra var agy injects into plugin-bundled servers.
const VALUE_RE = /^(ANTIGRAVITY_|GEMINI_|PROBE|PLUGIN_ROOT$)/;

function writeTest() {
  try {
    writeFileSync(WRITE_TARGET, `probe ${process.pid}\n`);
    unlinkSync(WRITE_TARGET);
    return { target: WRITE_TARGET, ok: true };
  } catch (err) {
    return { target: WRITE_TARGET, ok: false, error: String(err?.message ?? err) };
  }
}

function log(record) {
  try {
    appendFileSync(LOG, JSON.stringify(record) + "\n");
  } catch (err) {
    process.stderr.write(`predexec-probe: cannot write log ${LOG}: ${err}\n`);
  }
}

const startup = {
  event: "start",
  time: new Date().toISOString(),
  pid: process.pid,
  ppid: process.ppid,
  cwd: process.cwd(),
  argv: process.argv,
  envNames: Object.keys(process.env).sort(),
  envValues: Object.fromEntries(Object.entries(process.env).filter(([k]) => VALUE_RE.test(k))),
  write: writeTest(),
};
log(startup);
process.stderr.write(`predexec-probe: started pid=${process.pid} cwd=${process.cwd()} log=${LOG}\n`);

function createServer() {
  const server = new McpServer({ name: "predexec-probe", version: "0.0.0" });
  server.registerTool(
    "probe",
    {
      description: "Diagnostic probe. Returns how this MCP server process was spawned (cwd, env names, write test).",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const call = { event: "call", time: new Date().toISOString(), pid: process.pid, cwd: process.cwd(), write: writeTest() };
      log(call);
      const summary = { pid: startup.pid, ppid: startup.ppid, cwd: startup.cwd, write: startup.write, callWrite: call.write, envValues: startup.envValues };
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
    },
  );
  return server;
}

await serveStdio(createServer, {
  onerror: (err) => process.stderr.write(`predexec-probe transport error: ${err}\n`),
});
