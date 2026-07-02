#!/usr/bin/env node
/**
 * predexec CLI — `doctor` (install diagnostics) and `stats` (request accounting).
 *
 * Plain JS on node builtins only (no TS loader, no deps) so `npx -y predexec`
 * works anywhere. Check functions take base paths as parameters (homedir
 * defaults) so tests can point them at fixtures; `main()` only runs when
 * executed directly.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// ── shared ────────────────────────────────────────────────

/** Twin of stats.ts statsFilePath (kept in sync; asserted by unit test). */
export function statsFilePath(env = process.env) {
  const dir =
    env.PREDEXEC_STATE_DIR ||
    (env.XDG_STATE_HOME ? join(env.XDG_STATE_HOME, "predexec") : join(homedir(), ".local", "state", "predexec"));
  return join(dir, "stats.jsonl");
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ── doctor checks ─────────────────────────────────────────
// Each check returns { name, status: "ok"|"fail"|"skip", detail?, hint? }.

export function checkNodeVersion(version = process.versions.node) {
  const major = Number(version.split(".")[0]);
  return major >= 22
    ? { name: `node ${version} (>= 22)`, status: "ok" }
    : { name: `node ${version}`, status: "fail", hint: "predexec needs Node 22+ (engines.node)." };
}

/** pi: settings entry + installed package + zod sibling. */
export function checkPi(piAgentDir = join(homedir(), ".pi", "agent")) {
  const checks = [];
  const settings = readJson(join(piAgentDir, "settings.json"));
  if (!settings) {
    return [{ name: "pi not configured", status: "skip", detail: `no ${join(piAgentDir, "settings.json")}` }];
  }
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  const entry = packages.find((p) => typeof p === "string" && /predexec/.test(p));
  checks.push(
    entry
      ? { name: `pi settings: ${entry}`, status: "ok" }
      : { name: "pi settings: predexec entry", status: "fail", hint: "run `pi install npm:predexec`" },
  );

  const pkgDir = join(piAgentDir, "npm", "node_modules", "predexec");
  const pkg = readJson(join(pkgDir, "package.json"));
  checks.push(
    pkg
      ? { name: `pi install: predexec@${pkg.version}`, status: "ok", detail: pkgDir }
      : { name: "pi install: package present", status: "fail", hint: "run `pi install npm:predexec` (or `pi update --extensions`)" },
  );

  if (pkg) {
    const zod = readJson(join(piAgentDir, "npm", "node_modules", "zod", "package.json"));
    checks.push(
      zod
        ? { name: `pi install: zod@${zod.version} present`, status: "ok" }
        : { name: "pi install: zod dependency", status: "fail", hint: "reinstall: `pi remove npm:predexec && pi install npm:predexec`" },
    );
  }
  return checks;
}

/** Find opencode config that should carry the plugin entry. */
export function findOpencodeConfig(cwd = process.cwd(), home = homedir()) {
  const candidates = [join(cwd, "opencode.json"), join(home, ".config", "opencode", "opencode.json")];
  for (const path of candidates) {
    const json = readJson(path);
    if (json) return { path, json };
  }
  return null;
}

/** opencode: config entry + cache install + zod + loader-contract shape. */
export function checkOpencode(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? homedir();
  const cacheRoot = opts.cacheRoot ?? join(home, ".cache", "opencode", "packages");
  const checks = [];

  const config = findOpencodeConfig(cwd, home);
  if (!config) {
    return [{ name: "opencode not configured", status: "skip", detail: "no opencode.json (project or global)" }];
  }
  const plugins = Array.isArray(config.json.plugin) ? config.json.plugin : [];
  const entry = plugins.find((p) => typeof p === "string" && /^predexec(@.*)?$/.test(p));
  checks.push(
    entry
      ? { name: `opencode config: plugin "${entry}"`, status: "ok", detail: config.path }
      : {
          name: "opencode config: plugin entry",
          status: "fail",
          detail: config.path,
          hint: 'add "predexec" to the "plugin" array and restart opencode',
        },
  );
  if (!entry) return checks;

  // Cache install (any predexec / predexec@x dir).
  let cacheDirs = [];
  try {
    cacheDirs = readdirSync(cacheRoot).filter((d) => d === "predexec" || d.startsWith("predexec@"));
  } catch {
    /* no cache yet */
  }
  const installed = cacheDirs
    .map((d) => join(cacheRoot, d, "node_modules", "predexec"))
    .filter((p) => existsSync(join(p, "package.json")));
  if (installed.length === 0) {
    checks.push({
      name: "opencode cache: predexec installed",
      status: "fail",
      hint: "start opencode once so it fetches the plugin, or clear the cache and restart",
    });
    return checks;
  }

  for (const dir of installed) {
    const pkg = readJson(join(dir, "package.json"));
    checks.push({ name: `opencode cache: predexec@${pkg?.version ?? "?"}`, status: "ok", detail: dir });

    const zodOk =
      existsSync(join(dir, "node_modules", "zod", "package.json")) ||
      existsSync(join(dir, "..", "zod", "package.json"));
    checks.push(
      zodOk
        ? { name: "opencode cache: zod dependency present", status: "ok" }
        : {
            name: "opencode cache: zod dependency",
            status: "fail",
            hint: `clear ${join(dir, "..", "..")} and restart opencode (pre-0.1.1 installs lacked runtime deps)`,
          },
    );

    // Loader contract: opencode's readV1Plugin only reads the default export.
    let pluginSrc = "";
    try {
      pluginSrc = readFileSync(join(dir, ".opencode", "plugins", "predexec.ts"), "utf8");
    } catch {
      /* handled below */
    }
    checks.push(
      pluginSrc.includes("export default")
        ? { name: "opencode cache: plugin default-exports { id, server }", status: "ok" }
        : {
            name: "opencode cache: plugin export shape",
            status: "fail",
            hint: "cached version predates 0.1.1 (silently skipped by the loader) — clear the cache dir and restart opencode",
          },
    );
  }
  return checks;
}

/**
 * Live probe: spawn `opencode serve` on a random high port and poll
 * /experimental/tool/ids for "predexec". The gold check for silent loader skips.
 */
export async function liveProbe({ timeoutMs = 12000 } = {}) {
  const port = 4600 + Math.floor(Math.random() * 100);
  const child = spawn("opencode", ["serve", "--port", String(port)], { stdio: "ignore" });
  const spawnFailed = new Promise((resolveP) => child.once("error", () => resolveP("spawn-error")));
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const failed = await Promise.race([spawnFailed, new Promise((r) => setTimeout(r, 500))]);
      if (failed === "spawn-error") {
        return { name: "live probe: opencode on PATH", status: "skip", detail: "opencode binary not found" };
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/experimental/tool/ids`);
        const ids = await res.json();
        return Array.isArray(ids) && ids.includes("predexec")
          ? { name: "live probe: predexec registered in opencode", status: "ok" }
          : {
              name: "live probe: predexec registered in opencode",
              status: "fail",
              detail: `tool ids: ${JSON.stringify(ids)}`,
              hint: "plugin loaded config but was skipped — run `npx -y predexec doctor` checks above for the cause",
            };
      } catch {
        /* server not up yet — keep polling */
      }
    }
    return { name: "live probe: opencode serve responded", status: "fail", hint: "server never answered — check `opencode serve` manually" };
  } finally {
    child.kill();
  }
}

// ── stats aggregation ─────────────────────────────────────

export function parseStatsLines(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.v === 1);
}

export function summarizeStats(records) {
  const summary = {
    runs: records.length,
    byHarness: {},
    byStoppedReason: {},
    ops: 0,
    requestsSaved: 0,
    edgesEvaluated: 0,
    edgesMatched: 0,
    avgDepth: 0,
  };
  for (const r of records) {
    summary.byHarness[r.harness] = (summary.byHarness[r.harness] ?? 0) + 1;
    summary.byStoppedReason[r.stoppedReason] = (summary.byStoppedReason[r.stoppedReason] ?? 0) + 1;
    summary.ops += r.ops ?? 0;
    summary.requestsSaved += r.requestsSaved ?? 0;
    summary.edgesEvaluated += r.edgesEvaluated ?? 0;
    summary.edgesMatched += r.edgesMatched ?? 0;
    summary.avgDepth += r.depthReached ?? 0;
  }
  if (records.length > 0) summary.avgDepth = summary.avgDepth / records.length;
  return summary;
}

// ── CLI ───────────────────────────────────────────────────

function printCheck(c) {
  const box = c.status === "ok" ? "[x]" : c.status === "skip" ? "[-]" : "[ ]";
  console.log(`${box} ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  if (c.status === "fail" && c.hint) console.log(`    fix: ${c.hint}`);
}

async function doctor(args) {
  const checks = [checkNodeVersion(), ...checkPi(), ...checkOpencode()];
  if (args.includes("--live")) checks.push(await liveProbe());
  console.log("predexec doctor\n");
  for (const c of checks) printCheck(c);
  const failed = checks.filter((c) => c.status === "fail").length;
  console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) failed`);
  if (!args.includes("--live")) console.log("(run with --live to spawn opencode and probe tool registration)");
  return failed === 0 ? 0 : 1;
}

async function stats() {
  const file = statsFilePath();
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    console.log(`no runs recorded yet — ${file}`);
    return 0;
  }
  const records = parseStatsLines(text);
  if (records.length === 0) {
    console.log(`no runs recorded yet — ${file}`);
    return 0;
  }
  const s = summarizeStats(records);
  const hitRate = s.edgesEvaluated > 0 ? `${((s.edgesMatched / s.edgesEvaluated) * 100).toFixed(0)}%` : "n/a";
  console.log(`predexec stats — ${file}\n`);
  console.log(`runs:                 ${s.runs}  (${Object.entries(s.byHarness).map(([k, v]) => `${k}: ${v}`).join(", ")})`);
  console.log(`ops collapsed:        ${s.ops}`);
  console.log(`est. requests saved:  ${s.requestsSaved}`);
  console.log(`avg depth:            ${s.avgDepth.toFixed(1)}`);
  console.log(`edge hit rate:        ${hitRate}  (${s.edgesMatched}/${s.edgesEvaluated})`);
  console.log(`stops:                ${Object.entries(s.byStoppedReason).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  return 0;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "doctor") process.exit(await doctor(args));
  if (cmd === "stats") process.exit(await stats());
  console.log("usage: predexec <doctor [--live] | stats>");
  process.exit(cmd ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
