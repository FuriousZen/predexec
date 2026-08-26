/**
 * Release hygiene guards.
 *
 * 1. `.claude-plugin/plugin.json` carries its own `version` field, which `npm
 *    version` does NOT bump — the `version` lifecycle script (package.json)
 *    syncs it. This test catches the two files drifting apart (as happened at
 *    0.2.0 → 0.3.0).
 * 2. The test suite executes real plans through `executeAdapterPlan`, whose
 *    stats recorder appends to the REAL `~/.local/state/predexec/stats.jsonl`
 *    unless `PREDEXEC_STATE_DIR` is redirected. vitest.config.ts must pin it
 *    to a throwaway dir for the whole suite, or every run pollutes live stats
 *    (seen as "double-logged" policyStop rows: one per policy test per run).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureBuild } from "./helpers/ensure-build.ts";

describe("release hygiene", () => {
  it("plugin.json version matches package.json", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    const plugin = JSON.parse(readFileSync(join(".claude-plugin", "plugin.json"), "utf8")) as { version: string };
    expect(plugin.version).toBe(pkg.version);
  });

  it("suite-wide PREDEXEC_STATE_DIR isolation keeps tests out of real stats", () => {
    const dir = process.env.PREDEXEC_STATE_DIR;
    expect(dir, "vitest.config.ts must set test.env.PREDEXEC_STATE_DIR").toBeTruthy();
    expect(dir).not.toBe(join(homedir(), ".local", "state", "predexec"));
  });

  beforeAll(() => {
    // Serialized across processes: pack.test.ts's beforeAll can run concurrently
    // in a separate vitest worker and also builds dist/. See ensure-build.ts.
    ensureBuild();
  });

  it("compiled opencode main entry is ESM and exposes default.server (real Node, no vitest interop)", () => {
    const main = JSON.parse(readFileSync("package.json", "utf8")).main as string;
    const url = pathToFileURL(resolve(main)).href;
    // vitest's esbuild CJS interop honors __esModule and hides exactly this class
    // of breakage (0.3.0 shipped a CJS main that Bun/Node reject) — so assert in
    // a clean Node subprocess, the way real hosts load it.
    const script = `const m = await import(${JSON.stringify(url)}); if (typeof m.default?.server !== "function") { console.error("default.server is " + typeof m.default?.server); process.exit(1); }`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
  });
});
