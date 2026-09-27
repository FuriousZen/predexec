import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadUserConfig, userConfigPath } from "../user-config.ts";
import { executeAdapterPlan } from "../adapter-runtime.ts";

/**
 * The D1 opt-in is USER-level only: env vars and the XDG config file. Every
 * test pins HOME and XDG_CONFIG_HOME to throwaway dirs, so the real home is
 * never read.
 */
describe("loadUserConfig", () => {
  let home: string;
  let xdg: string;
  let repo: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "px-uc-home-"));
    xdg = mkdtempSync(join(tmpdir(), "px-uc-xdg-"));
    repo = mkdtempSync(join(tmpdir(), "px-uc-repo-"));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const dir of [home, xdg, repo]) rmSync(dir, { recursive: true, force: true });
  });

  const writeConfig = (dir: string, content: string) => {
    mkdirSync(join(dir, "predexec"), { recursive: true });
    writeFileSync(join(dir, "predexec", "config.json"), content);
  };

  it("returns empty options when nothing is configured", () => {
    expect(loadUserConfig({ HOME: home, XDG_CONFIG_HOME: xdg })).toEqual({ classifier: {}, warnings: [] });
  });

  it("reads comma-separated env entries, trimmed, blanks dropped", () => {
    const config = loadUserConfig({
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      PREDEXEC_ALLOW_SCRIPTS: " python3 scripts/report.py , npm run lint,,",
      PREDEXEC_READONLY_HEADS: "mytool",
    });
    expect(config.classifier).toEqual({
      allowScripts: ["python3 scripts/report.py", "npm run lint"],
      extraReadOnlyHeads: ["mytool"],
    });
    expect(config.warnings).toEqual([]);
  });

  it("merges env entries with $XDG_CONFIG_HOME/predexec/config.json", () => {
    writeConfig(xdg, JSON.stringify({ readOnlyHeads: ["a"], allowScripts: ["make test"] }));
    const config = loadUserConfig({ HOME: home, XDG_CONFIG_HOME: xdg, PREDEXEC_ALLOW_SCRIPTS: "npm run lint" });
    expect(config.classifier).toEqual({ allowScripts: ["npm run lint", "make test"], extraReadOnlyHeads: ["a"] });
    expect(config.warnings).toEqual([]);
  });

  it("defaults the config dir to $HOME/.config when XDG_CONFIG_HOME is unset", () => {
    writeConfig(join(home, ".config"), JSON.stringify({ allowScripts: ["just"] }));
    expect(userConfigPath({ HOME: home })).toBe(join(home, ".config", "predexec", "config.json"));
    expect(loadUserConfig({ HOME: home }).classifier).toEqual({ allowScripts: ["just"] });
  });

  it("ignores a relative XDG_CONFIG_HOME (the XDG spec says so) and falls back to $HOME/.config", () => {
    process.chdir(repo);
    writeConfig(join(repo, "rel"), JSON.stringify({ allowScripts: ["make"] }));
    expect(loadUserConfig({ HOME: home, XDG_CONFIG_HOME: "rel" }).classifier).toEqual({});
  });

  for (const [label, content] of [
    ["unparseable JSON", "{ nope"],
    ["a non-object", "[1,2]"],
    ["a non-array field", JSON.stringify({ allowScripts: "make" })],
    ["a non-string entry", JSON.stringify({ allowScripts: ["make", 3] })],
    ["an unknown key", JSON.stringify({ allowScript: ["make"] })],
  ] as const) {
    it(`a malformed config file (${label}) warns and yields no file options, never throws`, () => {
      writeConfig(xdg, content);
      const config = loadUserConfig({ HOME: home, XDG_CONFIG_HOME: xdg, PREDEXEC_READONLY_HEADS: "x" });
      expect(config.classifier).toEqual({ extraReadOnlyHeads: ["x"] });
      expect(config.warnings).toHaveLength(1);
      expect(config.warnings[0]).toContain(join(xdg, "predexec", "config.json"));
    });
  }

  it("takes no cwd and never reads config from under the session root", async () => {
    expect(loadUserConfig.length).toBeLessThanOrEqual(1);
    const hostile = JSON.stringify({ allowScripts: ["python3 script.py"], readOnlyHeads: ["python3"] });
    writeFileSync(join(repo, "config.json"), hostile);
    writeFileSync(join(repo, ".predexec.json"), hostile);
    writeConfig(join(repo, ".config"), hostile);
    mkdirSync(join(repo, ".predexec"));
    writeFileSync(join(repo, ".predexec", "config.json"), hostile);
    process.chdir(repo);
    expect(loadUserConfig({ HOME: home, XDG_CONFIG_HOME: xdg })).toEqual({ classifier: {}, warnings: [] });

    // End to end: the adapter runtime run from inside the repo still stops.
    const result = await executeAdapterPlan(
      { root: "a", nodes: [{ id: "a", commands: ["python3 script.py"] }] },
      "pi",
      { cwd: repo },
    );
    expect(result.stoppedReason).toBe("mutationStop");
    expect(result.transcript).toContain("runs repository script python3 script.py");
  });
});
