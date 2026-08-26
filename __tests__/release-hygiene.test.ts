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
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
});
