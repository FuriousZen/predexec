import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { installSkill, SKILL_HARNESSES, skillInstallTarget } from "../bin/predexec.mjs";
import { SKILL_PATHS } from "../steering.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const bin = fileURLToPath(new URL("../bin/predexec.mjs", import.meta.url));

let tmp: string;
const scratch = () => (tmp = mkdtempSync(join(tmpdir(), "px-install-skill-")));
afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

describe("SKILL_SOURCE_PATHS parity", () => {
  it("bin/predexec.mjs's plain-JS skill source paths match steering.ts's SKILL_PATHS", async () => {
    const { SKILL_SOURCE_PATHS } = await import("../bin/predexec.mjs");
    expect(SKILL_SOURCE_PATHS).toEqual(SKILL_PATHS);
  });
});

describe("skillInstallTarget", () => {
  it("resolves the global and --project target for every non-pi harness", () => {
    const home = "/home/u";
    const cwd = "/proj";
    expect(skillInstallTarget("claude", { home, cwd })).toBe(join(home, ".claude", "skills", "predexec"));
    expect(skillInstallTarget("claude", { home, cwd, project: true })).toBe(join(cwd, ".claude", "skills", "predexec"));

    expect(skillInstallTarget("codex", { home, cwd })).toBe(join(home, ".agents", "skills", "predexec"));
    expect(skillInstallTarget("codex", { home, cwd, project: true })).toBe(join(cwd, ".agents", "skills", "predexec"));

    expect(skillInstallTarget("opencode", { home, cwd })).toBe(
      join(home, ".config", "opencode", "skills", "predexec"),
    );
    expect(skillInstallTarget("opencode", { home, cwd, project: true })).toBe(
      join(cwd, ".opencode", "skills", "predexec"),
    );

    expect(skillInstallTarget("antigravity", { home, cwd })).toBe(
      join(home, ".gemini", "config", "skills", "predexec"),
    );
    expect(skillInstallTarget("antigravity", { home, cwd, project: true })).toBe(
      join(cwd, ".agents", "skills", "predexec"),
    );
  });

  it("honors CLAUDE_CONFIG_DIR for the claude global target", () => {
    const home = "/home/u";
    const configDir = "/custom/claude-config";
    expect(skillInstallTarget("claude", { home, configDir })).toBe(join(configDir, "skills", "predexec"));
  });
});

describe("installSkill", () => {
  const opts = (over: Record<string, unknown> = {}) => ({
    home: join(tmp, "home"),
    cwd: join(tmp, "proj"),
    ...over,
  });

  it("is a documented no-op for pi", () => {
    scratch();
    const result = installSkill("pi", opts());
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/nothing to install/);
  });

  it("rejects an unknown harness", () => {
    scratch();
    const result = installSkill("gemini-cli", opts());
    expect(result.ok).toBe(false);
    expect(result.message).toContain("unknown harness");
  });

  it("returns {ok:false, message} rather than throwing when the packaged source dir is missing (R40)", () => {
    scratch();
    const result = installSkill("claude", opts({ packageRoot: join(tmp, "corrupted-install") }));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/packaged skill source not found/);
    expect(result.message).toContain("claude");
  });

  it("lists every real harness (except pi) as installable", () => {
    expect(SKILL_HARNESSES).toEqual(["claude", "codex", "opencode", "antigravity", "pi"]);
  });

  it.each(["claude", "codex", "opencode", "antigravity"] as const)(
    "copies the packaged %s skill to its global target",
    (harness) => {
      scratch();
      const result = installSkill(harness, opts());
      expect(result.ok).toBe(true);
      const target = skillInstallTarget(harness, opts());
      expect(result.target).toBe(target);
      const written = readFileSync(join(target, "SKILL.md"), "utf8");
      const source = readFileSync(join(repoRoot, SKILL_PATHS[harness]), "utf8");
      expect(written).toBe(source);
    },
  );

  it.each(["claude", "codex", "opencode", "antigravity"] as const)(
    "copies the packaged %s skill to its --project target",
    (harness) => {
      scratch();
      const result = installSkill(harness, opts({ project: true }));
      expect(result.ok).toBe(true);
      const target = skillInstallTarget(harness, opts({ project: true }));
      expect(result.target).toBe(target);
      const written = readFileSync(join(target, "SKILL.md"), "utf8");
      const source = readFileSync(join(repoRoot, SKILL_PATHS[harness]), "utf8");
      expect(written).toBe(source);
    },
  );

  it("reports would-install and writes nothing on --dry-run", () => {
    scratch();
    const result = installSkill("claude", opts({ dryRun: true }));
    expect(result.ok).toBe(true);
    const target = skillInstallTarget("claude", opts());
    expect(() => readFileSync(join(target, "SKILL.md"), "utf8")).toThrow();
    expect(result.results[0]!.action).toBe("would-install");
  });

  it("reports would-overwrite with --force --dry-run and does not modify existing file", () => {
    scratch();
    const target = skillInstallTarget("claude", opts());
    mkdirSync(target, { recursive: true });
    const originalContent = "--- original ---";
    writeFileSync(join(target, "SKILL.md"), originalContent);

    const result = installSkill("claude", opts({ force: true, dryRun: true }));
    expect(result.ok).toBe(true);
    expect(result.results[0]!.action).toBe("would-overwrite");
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(originalContent);
  });

  it("is a no-op (ok) when the destination already has the identical packaged content", () => {
    scratch();
    installSkill("claude", opts());
    const second = installSkill("claude", opts());
    expect(second.ok).toBe(true);
    expect(second.results[0]!.action).toBe("up-to-date");
  });

  it("refuses to overwrite a differing existing file without --force", () => {
    scratch();
    const target = skillInstallTarget("claude", opts());
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "--- local edits, do not clobber ---");

    const result = installSkill("claude", opts());
    expect(result.ok).toBe(false);
    expect(result.results[0]!.action).toBe("conflict");
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("--- local edits, do not clobber ---");
  });

  it("overwrites a differing existing file with --force", () => {
    scratch();
    const target = skillInstallTarget("claude", opts());
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "--- stale ---");

    const result = installSkill("claude", opts({ force: true }));
    expect(result.ok).toBe(true);
    expect(result.results[0]!.action).toBe("overwritten");
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe(
      readFileSync(join(repoRoot, SKILL_PATHS.claude), "utf8"),
    );
  });
});

describe("install-skill CLI", () => {
  it("installs via the CLI entrypoint and prints the destination", () => {
    scratch();
    const home = join(tmp, "home");
    const proj = join(tmp, "proj");
    mkdirSync(proj, { recursive: true });
    const run = spawnSync(process.execPath, [bin, "install-skill", "claude", "--project"], {
      encoding: "utf8",
      cwd: proj,
      env: { ...process.env, HOME: home },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("destination:");
    const installed = readFileSync(join(proj, ".claude", "skills", "predexec", "SKILL.md"), "utf8");
    expect(installed).toBe(readFileSync(join(repoRoot, SKILL_PATHS.claude), "utf8"));
  });

  it("prints usage and exits 1 with no harness argument", () => {
    const run = spawnSync(process.execPath, [bin, "install-skill"], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("usage: predexec install-skill");
  });

  it("prints usage and exits 1 for an unknown harness", () => {
    const run = spawnSync(process.execPath, [bin, "install-skill", "nonsense"], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("unknown harness");
  });

  it("prints would install and dry run message with --dry-run", () => {
    scratch();
    const home = join(tmp, "home");
    const proj = join(tmp, "proj");
    mkdirSync(proj, { recursive: true });
    const run = spawnSync(process.execPath, [bin, "install-skill", "claude", "--dry-run"], {
      encoding: "utf8",
      cwd: proj,
      env: { ...process.env, HOME: home },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("would install:");
    expect(run.stdout).toContain("dry run — nothing written");
    expect(() => readFileSync(join(home, ".claude", "skills", "predexec", "SKILL.md"), "utf8")).toThrow();
  });

  it("prints would overwrite with --force --dry-run and does not modify file", () => {
    scratch();
    const home = join(tmp, "home");
    const proj = join(tmp, "proj");
    const skillDir = join(home, ".claude", "skills", "predexec");
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(proj, { recursive: true });
    const originalContent = "--- original ---";
    writeFileSync(join(skillDir, "SKILL.md"), originalContent);

    const run = spawnSync(process.execPath, [bin, "install-skill", "claude", "--force", "--dry-run"], {
      encoding: "utf8",
      cwd: proj,
      env: { ...process.env, HOME: home },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("would overwrite:");
    expect(run.stdout).toContain("dry run — nothing written");
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe(originalContent);
  });

  it("prints installed (non-dry-run) with exact action text and writes the file", () => {
    scratch();
    const home = join(tmp, "home");
    const proj = join(tmp, "proj");
    mkdirSync(proj, { recursive: true });
    const run = spawnSync(process.execPath, [bin, "install-skill", "claude"], {
      encoding: "utf8",
      cwd: proj,
      env: { ...process.env, HOME: home },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("installed:");
    expect(run.stdout).toContain("destination:");
    expect(run.stdout).not.toContain("dry run");
    const installed = readFileSync(join(home, ".claude", "skills", "predexec", "SKILL.md"), "utf8");
    expect(installed).toBe(readFileSync(join(repoRoot, SKILL_PATHS.claude), "utf8"));
  });

  it("prints up-to-date (not up to-date) on second unchanged run", () => {
    scratch();
    const home = join(tmp, "home");
    const proj = join(tmp, "proj");
    mkdirSync(proj, { recursive: true });
    // First run: install
    const run1 = spawnSync(process.execPath, [bin, "install-skill", "claude"], {
      encoding: "utf8",
      cwd: proj,
      env: { ...process.env, HOME: home },
    });
    expect(run1.status).toBe(0);
    expect(run1.stdout).toContain("installed:");
    // Second run: should report up-to-date (with both hyphens preserved)
    const run2 = spawnSync(process.execPath, [bin, "install-skill", "claude"], {
      encoding: "utf8",
      cwd: proj,
      env: { ...process.env, HOME: home },
    });
    expect(run2.status).toBe(0);
    expect(run2.stdout).toContain("up-to-date:");
    expect(run2.stdout).not.toContain("up to-date:");
  });
});
