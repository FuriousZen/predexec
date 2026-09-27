import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadUserConfig, sessionTrustProblem, userConfigPath } from "../user-config.ts";
import { executeAdapterPlan, userClassifierOptions } from "../adapter-runtime.ts";

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

  it("a FIFO, a directory or an oversized file at the config path warns and is never read (no hang)", () => {
    mkdirSync(join(xdg, "predexec", "config.json"), { recursive: true });
    const dir = loadUserConfig({ HOME: home, XDG_CONFIG_HOME: xdg });
    expect(dir.classifier).toEqual({});
    expect(dir.warnings[0]).toMatch(/not a regular file/);
    rmSync(join(xdg, "predexec"), { recursive: true });

    writeConfig(xdg, JSON.stringify({ allowScripts: ["x".repeat(70 * 1024)] }));
    const big = loadUserConfig({ HOME: home, XDG_CONFIG_HOME: xdg });
    expect(big.classifier).toEqual({});
    expect(big.warnings[0]).toMatch(/larger than 65536 bytes/);
    rmSync(join(xdg, "predexec"), { recursive: true });

    mkdirSync(join(xdg, "predexec"));
    execFileSync("mkfifo", [join(xdg, "predexec", "config.json")]);
    const fifo = loadUserConfig({ HOME: home, XDG_CONFIG_HOME: xdg });
    expect(fifo.classifier).toEqual({});
    expect(fifo.warnings[0]).toMatch(/not a regular file/);
  });

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

  it("adapters load the config once per plan run and surface its warnings in the transcript (R38 minor 6)", async () => {
    const saved = { xdg: process.env.XDG_CONFIG_HOME, allow: process.env.PREDEXEC_ALLOW_SCRIPTS };
    try {
      process.env.XDG_CONFIG_HOME = xdg;
      process.env.PREDEXEC_ALLOW_SCRIPTS = "";
      const plan = { root: "a", nodes: [{ id: "a", commands: ["echo ok"] }] };
      await executeAdapterPlan(plan, "pi", { cwd: repo });
      expect(userClassifierOptions()).toEqual({});
      // A nudge between plan runs reuses the plan run's load, not a re-read.
      process.env.PREDEXEC_ALLOW_SCRIPTS = "npm run lint";
      expect(userClassifierOptions()).toEqual({});
      // A malformed file: the next plan run reloads and reports it.
      writeConfig(xdg, "{ nope");
      const result = await executeAdapterPlan(plan, "pi", { cwd: repo });
      expect(result.transcript).toContain(`predexec: ignoring ${join(xdg, "predexec", "config.json")}`);
      expect(userClassifierOptions()).toEqual({ allowScripts: ["npm run lint"] });
    } finally {
      process.env.XDG_CONFIG_HOME = saved.xdg;
      process.env.PREDEXEC_ALLOW_SCRIPTS = saved.allow;
    }
  });
});

/**
 * I3 / R63: the user's allowlists are disabled (fail closed) when the
 * repository could have chosen them: (a) the resolved config file lies inside
 * the session root, or (b) on Claude Code, a project-scope settings file in
 * the session root declares an `env` key that selects them. Throwaway HOME,
 * XDG and repo dirs only.
 */
describe("session trust (R63)", () => {
  let home: string;
  let xdg: string;
  let repo: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "px-st-home-"));
    xdg = mkdtempSync(join(tmpdir(), "px-st-xdg-"));
    repo = mkdtempSync(join(tmpdir(), "px-st-repo-"));
  });
  afterEach(() => {
    for (const dir of [home, xdg, repo]) rmSync(dir, { recursive: true, force: true });
  });

  const claudeSettings = (name: string, content: string) => {
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude", name), content);
  };

  it("accepts a config outside the session root", () => {
    expect(sessionTrustProblem({ sessionRoot: repo, host: "claude-code", env: { HOME: home, XDG_CONFIG_HOME: xdg } })).toBeNull();
  });

  it("(a) refuses a config file path inside the session root", () => {
    const problem = sessionTrustProblem({ sessionRoot: repo, host: "pi", env: { HOME: home, XDG_CONFIG_HOME: join(repo, "cfg") } });
    expect(problem).toMatch(/inside the session root/);
    expect(sessionTrustProblem({ sessionRoot: repo, host: "codex", env: { HOME: repo } })).toMatch(/inside the session root/);
  });

  it.each(["settings.json", "settings.local.json"])("(b) refuses Claude project %s env selecting the allowlists", (name) => {
    for (const key of ["PREDEXEC_READONLY_HEADS", "PREDEXEC_ALLOW_SCRIPTS", "XDG_CONFIG_HOME"]) {
      claudeSettings(name, JSON.stringify({ env: { [key]: "x" } }));
      const problem = sessionTrustProblem({ sessionRoot: repo, host: "claude-code", env: { HOME: home, XDG_CONFIG_HOME: xdg } });
      expect(problem).toContain(key);
    }
  });

  it("(b) ignores other env keys, other hosts, and fails closed on an unreadable settings file", () => {
    claudeSettings("settings.json", JSON.stringify({ env: { FOO: "1" }, permissions: {} }));
    const env = { HOME: home, XDG_CONFIG_HOME: xdg };
    expect(sessionTrustProblem({ sessionRoot: repo, host: "claude-code", env })).toBeNull();
    claudeSettings("settings.json", JSON.stringify({ env: { PREDEXEC_ALLOW_SCRIPTS: "make" } }));
    expect(sessionTrustProblem({ sessionRoot: repo, host: "codex", env })).toBeNull();
    claudeSettings("settings.json", "{ nope");
    expect(sessionTrustProblem({ sessionRoot: repo, host: "claude-code", env })).toMatch(/could not be read/);
  });

  // R68: a first path component that merely BEGINS with ".." is inside.
  it("(a) refuses a config under a root subdirectory whose name begins with \"..\"", () => {
    const problem = sessionTrustProblem({ sessionRoot: repo, host: "pi", env: { HOME: home, XDG_CONFIG_HOME: join(repo, "..h") } });
    expect(problem).toMatch(/inside the session root/);
    expect(sessionTrustProblem({ sessionRoot: repo, host: "pi", env: { HOME: join(repo, "..h") } })).toMatch(/inside the session root/);
  });

  it("(a) still accepts a config in a sibling directory of the root", () => {
    const sibling = `${repo}-sibling`;
    try {
      mkdirSync(sibling);
      expect(sessionTrustProblem({ sessionRoot: repo, host: "pi", env: { HOME: home, XDG_CONFIG_HOME: sibling } })).toBeNull();
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  // R68: a relative HOME or XDG_CONFIG_HOME resolves against the cwd, which
  // the repository controls; fail closed on every host.
  it.each([
    ["a relative HOME", { HOME: "..h" }],
    ["a relative HOME (plain name)", { HOME: "h" }],
    ["a relative XDG_CONFIG_HOME", { XDG_CONFIG_HOME: "rel" }],
  ] as const)("refuses %s", (_label, overrides) => {
    const env = { HOME: home, XDG_CONFIG_HOME: xdg, ...overrides };
    expect(sessionTrustProblem({ sessionRoot: repo, host: "codex", env })).toMatch(/relative/);
  });

  it("(b) refuses Claude project settings env setting HOME", () => {
    claudeSettings("settings.json", JSON.stringify({ env: { HOME: "..h" } }));
    const problem = sessionTrustProblem({ sessionRoot: repo, host: "claude-code", env: { HOME: home, XDG_CONFIG_HOME: xdg } });
    expect(problem).toContain("HOME");
  });

  it("the adapter runtime disables the allowlists and says so in the transcript", async () => {
    const saved = { xdg: process.env.XDG_CONFIG_HOME, allow: process.env.PREDEXEC_ALLOW_SCRIPTS, home: process.env.HOME };
    try {
      process.env.HOME = home;
      process.env.XDG_CONFIG_HOME = xdg;
      process.env.PREDEXEC_ALLOW_SCRIPTS = "./hello.sh";
      claudeSettings("settings.local.json", JSON.stringify({ env: { PREDEXEC_ALLOW_SCRIPTS: "./hello.sh" } }));
      const plan = { root: "a", nodes: [{ id: "a", commands: ["./hello.sh"] }] };
      const stopped = await executeAdapterPlan(plan, "claude-code", { cwd: repo });
      expect(stopped.stoppedReason).toBe("mutationStop");
      expect(stopped.transcript).toMatch(/allowlists disabled/);
      expect(userClassifierOptions()).toEqual({});
    } finally {
      process.env.XDG_CONFIG_HOME = saved.xdg;
      process.env.PREDEXEC_ALLOW_SCRIPTS = saved.allow;
      process.env.HOME = saved.home;
    }
  });
});
