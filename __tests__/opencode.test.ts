import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// `server` is accessed through the default export (`plugin.server`), not as a
// named import: that mirrors what current opencode loaders (readV1Plugin)
// actually read, and `server` is deliberately not a named export (see the
// plugin file's footer).
import pluginSource, { createToolExecutor as createToolExecutorSource } from "../.opencode/plugins/predexec.ts";
// Requires a prior `pnpm run build` — the compiled variant is asserted against the same contract as the source.
import pluginCompiled, { createToolExecutor as createToolExecutorCompiled } from "../dist/.opencode/plugins/predexec.js";
import {
  MAX_FIND_RESULTS,
  MAX_GREP_CONTEXT,
  MAX_GREP_RESULTS,
  MAX_LS_ENTRIES,
  MAX_READ_LINES,
  MAX_GREP_PATTERN_LENGTH,
  type ToolOp,
} from "../core/index.ts";
import { PLAN_SHAPE_DESCRIPTION } from "../plan-language.ts";
import { renderSkill, STEERING_LINE } from "../steering.ts";

// read/ls pre-check path existence against the cwd, so mocked-client tests
// need a real directory with the paths their ops name.
const repo = mkdtempSync(join(tmpdir(), "px-opencode-"));
writeFileSync(join(repo, "a.ts"), "x");
mkdirSync(join(repo, "src"));
writeFileSync(join(repo, "src", "a.ts"), "x");

// The plugin reads process.env for opencode config discovery. Policy e2e tests
// isolate it: every OPENCODE_* source cleared, and global/data/home/managed
// config pointed at an empty tmp dir, so a developer's real opencode config
// cannot change a verdict.
const isolateOpencodeEnv = () => {
  beforeEach(() => {
    const scratch = mkdtempSync(join(tmpdir(), "px-oc-env-"));
    vi.stubEnv("XDG_CONFIG_HOME", join(scratch, "config"));
    vi.stubEnv("XDG_DATA_HOME", join(scratch, "data"));
    vi.stubEnv("OPENCODE_TEST_HOME", join(scratch, "home"));
    vi.stubEnv("OPENCODE_TEST_MANAGED_CONFIG_DIR", join(scratch, "managed"));
    for (const name of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_PERMISSION"]) {
      vi.stubEnv(name, undefined);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
};

const variants = [
  { name: "source (.opencode/plugins/predexec.ts)", plugin: pluginSource, createToolExecutor: createToolExecutorSource },
  { name: "compiled (dist/.opencode/plugins/predexec.js)", plugin: pluginCompiled, createToolExecutor: createToolExecutorCompiled },
];

describe.each(variants)("opencode plugin ($name) — loader contract", ({ plugin }) => {
  // opencode's readV1Plugin loads ONLY the default export and requires
  // { server() }; a named-export-only module is silently skipped.
  it("default-exports { id, server } for current opencode loaders", () => {
    expect(plugin.id).toBe("predexec");
    expect(typeof plugin.server).toBe("function");
  });

  it("server() registers the predexec tool with plain-object definition and hooks", async () => {
    const hooks = await plugin.server({ client: {} } as any);
    const def = (hooks as any).tool?.predexec;
    expect(def).toBeDefined();
    expect(typeof def.description).toBe("string");
    expect(typeof def.execute).toBe("function");
    // args must be zod v4 schemas — a v3 schema (or none) crashes the host
    // with `n._zod.def` (see context-mode's zod3tov4 notes).
    expect(def.args.plan._zod?.def).toBeDefined();
    expect(typeof (hooks as any)["experimental.chat.system.transform"]).toBe("function");
    expect(typeof (hooks as any)["tool.execute.after"]).toBe("function");
    expect(typeof (hooks as any).config).toBe("function");
  });
});

describe.each(variants)("opencode plugin ($name) — packaged skill registration via config hook", ({ plugin }) => {
  // Repo root, computed independently of the plugin's own import.meta.url
  // walk (which locates package.json by name rather than a fixed `..`
  // count) — the test asserts on the RESULT the hook produces, not by
  // mirroring that resolution logic.
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const packagedSkillDir = join(repoRoot, "skills", "opencode");

  it("appends the packaged skills/opencode absolute path to cfg.skills.paths", async () => {
    const hooks = await plugin.server({ client: {} } as any);
    const cfg: any = {};
    await (hooks as any).config(cfg);
    expect(cfg.skills?.paths).toContain(packagedSkillDir);
  });

  it("preserves pre-existing skills.paths entries", async () => {
    const hooks = await plugin.server({ client: {} } as any);
    const cfg: any = { skills: { paths: ["/existing/one"] } };
    await (hooks as any).config(cfg);
    expect(cfg.skills.paths).toEqual(["/existing/one", packagedSkillDir]);
  });

  it("is idempotent — calling config twice does not duplicate the entry", async () => {
    const hooks = await plugin.server({ client: {} } as any);
    const cfg: any = {};
    await (hooks as any).config(cfg);
    await (hooks as any).config(cfg);
    expect(cfg.skills.paths.filter((p: string) => p === packagedSkillDir)).toHaveLength(1);
  });

  it("does not disturb unrelated cfg fields", async () => {
    const hooks = await plugin.server({ client: {} } as any);
    const cfg: any = { plugin: ["predexec"], skills: { urls: ["https://example.invalid"] } };
    await (hooks as any).config(cfg);
    expect(cfg.plugin).toEqual(["predexec"]);
    expect(cfg.skills.urls).toEqual(["https://example.invalid"]);
    expect(cfg.skills.paths).toContain(packagedSkillDir);
  });

  // Task 17 review, Critical #1: a throw from the config hook could abort
  // opencode's plugin.init() for every plugin, not just this one's skill
  // registration — so a malformed cfg.skills / cfg.skills.paths must never
  // throw, and the hook must never silently corrupt a shape it doesn't
  // recognize. The hook itself is synchronous (it returns void, not a
  // Promise), so these assert with a plain `expect(() => ...).not.toThrow()`
  // rather than `.resolves`, which requires an actual thenable.
  const callConfig = (hooks: unknown, cfg: unknown): unknown => (hooks as any).config(cfg);

  it("cfg.skills.paths as a bare string is normalized to an array (opencode's own scan would otherwise iterate it character-by-character)", async () => {
    const hooks = await plugin.server({ client: {} } as any);
    const cfg: any = { skills: { paths: "/some/existing/path" } };
    expect(() => callConfig(hooks, cfg)).not.toThrow();
    expect(cfg.skills.paths).toEqual(["/some/existing/path", packagedSkillDir]);
  });

  it("cfg.skills.paths as null is treated the same as absent", async () => {
    const hooks = await plugin.server({ client: {} } as any);
    const cfg: any = { skills: { paths: null } };
    expect(() => callConfig(hooks, cfg)).not.toThrow();
    expect(cfg.skills.paths).toEqual([packagedSkillDir]);
  });

  it.each([
    ["a number", 42],
    ["a plain object", { not: "an array" }],
  ])("cfg.skills.paths as %s is left untouched and registration is skipped, without throwing", async (_label, badPaths) => {
    const hooks = await plugin.server({ client: {} } as any);
    const cfg: any = { skills: { paths: badPaths } };
    expect(() => callConfig(hooks, cfg)).not.toThrow();
    expect(cfg.skills.paths).toBe(badPaths);
  });

  it.each([
    ["a string", "not-an-object"],
    ["an array", ["not", "an", "object"]],
  ])("cfg.skills as %s is left untouched and registration is skipped, without throwing", async (_label, badSkills) => {
    const hooks = await plugin.server({ client: {} } as any);
    const cfg: any = { skills: badSkills };
    expect(() => callConfig(hooks, cfg)).not.toThrow();
    expect(cfg.skills).toBe(badSkills);
  });

  it("cfg itself being a non-object never throws", async () => {
    const hooks = await plugin.server({ client: {} } as any);
    expect(() => callConfig(hooks, "not-an-object")).not.toThrow();
    expect(() => callConfig(hooks, null)).not.toThrow();
  });
});

describe.each(variants)("opencode createToolExecutor ($name) — SDK response mapping", ({ createToolExecutor }) => {
  const run = (client: any, op: ToolOp) =>
    createToolExecutor(client, repo)(op, { cwd: repo });
  it("read: passes file content through as stdout", async () => {
    const client = { file: { read: async () => ({ data: { content: "line1\nline2\nline3" } }) } };
    const r = await run(client, { tool: "read", path: "a.ts" });
    expect(r).toEqual({ stdout: "line1\nline2\nline3", stderr: "", exitCode: 0 });
  });

  it("read: applies offset/limit client-side (offset is 1-based)", async () => {
    const client = { file: { read: async () => ({ data: { content: "l1\nl2\nl3\nl4\nl5" } }) } };
    const r = await run(client, { tool: "read", path: "a.ts", offset: 2, limit: 2 });
    expect(r.stdout).toBe("l2\nl3");
    expect(r.exitCode).toBe(0);
  });

  it("accepts exact shared ceilings and rejects over-ceiling direct calls before SDK work", async () => {
    const calls: string[] = [];
    const client = {
      file: {
        read: async () => (calls.push("read"), { data: { content: "line" } }),
        list: async () => (calls.push("ls"), { data: [{ name: "entry" }] }),
      },
      find: {
        text: async () => (calls.push("grep"), { data: [{ path: { text: "a.ts" }, lines: { text: "x" }, line_number: 1 }] }),
        files: async () => (calls.push("find"), { data: ["a.ts"] }),
      },
    };
    const executor = createToolExecutor(client as any, repo);
    for (const operation of [
      { tool: "read", path: "a.ts", limit: MAX_READ_LINES },
      { tool: "grep", pattern: "x", limit: MAX_GREP_RESULTS },
      { tool: "find", pattern: "*.ts", limit: MAX_FIND_RESULTS },
      { tool: "ls", path: ".", limit: MAX_LS_ENTRIES },
      { tool: "grep", pattern: "x", context: MAX_GREP_CONTEXT },
      { tool: "grep", pattern: "x".repeat(MAX_GREP_PATTERN_LENGTH) },
    ]) {
      expect((await executor(operation, { cwd: repo })).stderr).not.toContain("at most");
    }
    // OpenCode's native grep does not support context; the exact-bound context
    // is rejected as an unsupported host feature, but remains below predexec's
    // shared ceiling and therefore does not reach the SDK.
    expect(calls).toEqual(["read", "grep", "find", "ls", "grep"]);

    calls.length = 0;
    for (const operation of [
      { tool: "read", path: "a.ts", limit: MAX_READ_LINES + 1 },
      { tool: "grep", pattern: "x", limit: MAX_GREP_RESULTS + 1 },
      { tool: "find", pattern: "*.ts", limit: MAX_FIND_RESULTS + 1 },
      { tool: "ls", path: ".", limit: MAX_LS_ENTRIES + 1 },
      { tool: "grep", pattern: "x", context: MAX_GREP_CONTEXT + 1 },
      { tool: "grep", pattern: "x".repeat(MAX_GREP_PATTERN_LENGTH + 1) },
    ]) {
      const result = await executor(operation, { cwd: repo });
      // A rejected operation never reaches the SDK — it never ran, so it
      // takes the shared "never ran" exit code (2), not the "ran, found
      // nothing" code (1). See the exit-code convention block above runToolOp.
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toMatch(/at most|maximum length/);
    }
    expect(calls).toEqual([]);
  });

  it("read: forwards path + cwd to the SDK query", async () => {
    let seen: any;
    const client = { file: { read: async (o: any) => ((seen = o), { data: { content: "x" } }) } };
    await run(client, { tool: "read", path: "src/a.ts" });
    expect(seen).toEqual({ query: { path: "src/a.ts", directory: repo } });
  });

  it("grep: formats matches as path:line:text", async () => {
    const client = {
      find: {
        text: async () => ({
          data: [
            { path: { text: "a.ts" }, lines: { text: "const x = 1" }, line_number: 5 },
            { path: { text: "b.ts" }, lines: { text: "const x = 2" }, line_number: 9 },
          ],
        }),
      },
    };
    const r = await run(client, { tool: "grep", pattern: "const x" });
    expect(r.stdout).toBe("a.ts:5:const x = 1\nb.ts:9:const x = 2");
    expect(r.exitCode).toBe(0);
  });

  it("grep: no matches => exitCode 1", async () => {
    const client = { find: { text: async () => ({ data: [] }) } };
    const r = await run(client, { tool: "grep", pattern: "nope" });
    expect(r).toEqual({ stdout: "", stderr: "", exitCode: 1 });
  });

  it("find: joins paths with newlines", async () => {
    const client = { find: { files: async () => ({ data: ["src/a.ts", "src/b.ts"] }) } };
    const r = await run(client, { tool: "find", pattern: "*.ts" });
    expect(r.stdout).toBe("src/a.ts\nsrc/b.ts");
    expect(r.exitCode).toBe(0);
  });

  it("ls: maps file nodes to names", async () => {
    const client = {
      file: { list: async () => ({ data: [{ name: "a.ts", path: "src/a.ts" }, { name: "b.ts" }] }) },
    };
    const r = await run(client, { tool: "ls", path: "src" });
    expect(r.stdout).toBe("a.ts\nb.ts");
    expect(r.exitCode).toBe(0);
  });

  it("maps an SDK error to exit 2 (the op never ran), attributed to the op", async () => {
    const client = { file: { read: async () => ({ error: "boom" }) } };
    const r = await run(client, { tool: "read", path: "a.ts" });
    expect(r).toEqual({ stdout: "", stderr: "read a.ts: boom", exitCode: 2 });
  });

  it("unknown tool => exit 2 (the op never ran)", async () => {
    const r = await run({}, { tool: "deploy" } as ToolOp);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown tool: deploy");
  });

  it("a thrown SDK call is caught and reported as exit 2", async () => {
    const client = { file: { read: async () => { throw new Error("network down"); } } };
    const r = await run(client, { tool: "read", path: "a.ts" });
    expect(r).toEqual({ stdout: "", stderr: "read: network down", exitCode: 2 });
  });

  it("read: a {type:'binary'} response is exit 2, never treated as text content", async () => {
    const client = { file: { read: async () => ({ data: { type: "binary", content: "AAA=", encoding: "base64", mimeType: "image/png" } }) } };
    const r = await run(client, { tool: "read", path: "a.ts" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("binary file");
    expect(r.stdout).toBe("");
  });

  it("read: a {type:'text'} response still passes content through (real-shape parity)", async () => {
    const client = { file: { read: async () => ({ data: { type: "text", content: "hello" } }) } };
    const r = await run(client, { tool: "read", path: "a.ts" });
    expect(r).toEqual({ stdout: "hello", stderr: "", exitCode: 0 });
  });
});

describe.each(variants)("opencode createToolExecutor ($name) — grep/find arg handling", ({ createToolExecutor }) => {
  const run = (client: any, op: ToolOp) =>
    createToolExecutor(client, repo)(op, { cwd: repo });

  const matchRow = (path: string, line: number) => ({
    path: { text: path },
    lines: { text: "const x = 1" },
    line_number: line,
  });

  it("grep: `path` queries the SESSION ROOT (never a subdirectory) and scopes client-side by prefix", async () => {
    // A subdirectory `directory` value routes to a DIFFERENT opencode instance
    // (workspace-routing.ts's defaultDirectory() keys instance selection off
    // this exact query param — measured against 1.18.32), so every call must
    // send the fixed session root; subdirectory scoping happens by filtering
    // the root-wide results by path prefix instead.
    let seen: any;
    const client = {
      find: {
        text: async (o: any) => (
          (seen = o),
          { data: [matchRow("src/a.ts", 1), matchRow("other/b.ts", 2)] }
        ),
      },
    };
    const r = await run(client, { tool: "grep", pattern: "x", path: "src" });
    expect(seen.query.directory).toBe(repo);
    expect(r.stdout).toBe("src/a.ts:1:const x = 1");
    expect(r.exitCode).toBe(0);
  });

  it("grep: a FILE `path` fails loudly instead of silently searching the repo (op never ran)", async () => {
    const client = { find: { text: async () => ({ data: [] }) } };
    const r = await run(client, { tool: "grep", pattern: "x", path: "a.ts" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('"a.ts" is a file');
  });

  it("grep: a missing `path` fails with the resolved location (op never ran)", async () => {
    const client = { find: { text: async () => ({ data: [] }) } };
    const r = await run(client, { tool: "grep", pattern: "x", path: "nope/" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("path not found: nope/");
  });

  it("grep: unsupported args error loudly, naming them (op never ran)", async () => {
    const client = { find: { text: async () => ({ data: [] }) } };
    const r = await run(client, { tool: "grep", pattern: "x", glob: "*.ts", ignoreCase: true });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unsupported arg(s) in opencode adapter: glob, ignoreCase");
  });

  it("grep: `limit` slices matches client-side", async () => {
    const client = {
      find: { text: async () => ({ data: [matchRow("a.ts", 1), matchRow("b.ts", 2), matchRow("c.ts", 3)] }) },
    };
    const r = await run(client, { tool: "grep", pattern: "x", limit: 2 });
    expect(r.stdout.split("\n")).toHaveLength(2);
  });

  it("grep: reports caller truncation when the SDK returned more rows than requested", async () => {
    const client = {
      find: { text: async () => ({ data: [matchRow("a.ts", 1), matchRow("b.ts", 2), matchRow("c.ts", 3)] }) },
    };
    const r = await run(client, { tool: "grep", pattern: "x", limit: 2 });
    expect(r.stdout.split("\n")).toHaveLength(2);
    expect(r.stderr).toContain("caller limit 2 reached");
    expect(r.stderr).toContain("results may be incomplete");
    expect(r.stdoutTruncated).toBe(true);
  });

  it("find: `path` queries the SESSION ROOT (never a subdirectory) and scopes client-side by prefix", async () => {
    let seen: any;
    const client = {
      find: { files: async (o: any) => ((seen = o), { data: ["src/a.ts", "other/b.ts", "src/c.ts"] }) },
    };
    const r = await run(client, { tool: "find", pattern: "*.ts", path: "src", limit: 1 });
    expect(seen.query.directory).toBe(repo);
    // Regression: omitting `limit` from the query let opencode apply its own
    // default of 10, silently truncating every larger result set. The plugin
    // peeks one row past what it needs (min(limit,200)+1) to tell "exactly
    // enough" from "truncated" — see the truncation test below.
    expect(seen.query.limit).toBe(2);
    expect(r.stdout).toBe("src/a.ts");
  });

  it("find: sends a limit above opencode's default of 10 when the op omits one", async () => {
    let seen: any;
    const client = { find: { files: async (o: any) => ((seen = o), { data: [] }) } };
    await run(client, { tool: "find", pattern: "*.ts" });
    expect(seen.query.limit).toBeGreaterThan(10);
  });

  it("find: caps the server-side limit at 200 and peeks one extra row to detect truncation", async () => {
    // FindFileQuery.limit is bounded 1..200 server-side (opencode 1.18.32
    // packages/opencode/src/server/routes/instance/httpapi/groups/file.ts:27-32);
    // a raw request for 201 is rejected outright, so the peek itself must never
    // cross the ceiling.
    let seen: any;
    const rows = Array.from({ length: 200 }, (_, i) => `f${i}.ts`);
    const client = { find: { files: async (o: any) => ((seen = o), { data: rows }) } };
    const r = await run(client, { tool: "find", pattern: "*.ts", limit: 500 });
    expect(seen.query.limit).toBeLessThanOrEqual(200);
    expect(r.stdout.split("\n")).toHaveLength(200);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderr).toContain("caps results at 200");
    expect(r.exitCode).toBe(0);
  });

  it("find: flags truncation when the peeked extra row comes back, within the 200 ceiling", async () => {
    let seen: any;
    const client = {
      find: { files: async (o: any) => ((seen = o), { data: ["a.ts", "b.ts", "c.ts"] }) },
    };
    const r = await run(client, { tool: "find", pattern: "*.ts", limit: 2 });
    expect(seen.query.limit).toBe(3);
    expect(r.stdout.split("\n")).toHaveLength(2);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderr).toContain("more than 2 matches exist");
  });

  // C1 (review round 1): at exactly `limit: 200` (no `path`), `probeLimit`
  // collapses to `effectiveLimit` (both 200) because the peek can never cross
  // opencode's hard ceiling — the extra-row trick simply has no room to work.
  // A full 200-row page is then ambiguous: it looks identical whether the
  // real total is exactly 200 or far more. Flag it either way rather than
  // silently reporting exitCode 0 with no truncation signal.
  it("find: limit:200 with 250 real matches — server can only ever return 200, must still flag truncation", async () => {
    let seen: any;
    // The server enforces the 1..200 bound itself, so it can only ever hand
    // back at most `probeLimit` (200) rows regardless of how many real
    // matches exist upstream — 250 real matches and exactly 200 real matches
    // are, from the client's perspective, indistinguishable.
    const rows = Array.from({ length: 200 }, (_, i) => `f${i}.ts`);
    const client = { find: { files: async (o: any) => ((seen = o), { data: rows }) } };
    const r = await run(client, { tool: "find", pattern: "*.ts", limit: 200 });
    expect(seen.query.limit).toBe(200);
    expect(r.stdout.split("\n")).toHaveLength(200);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderr).toContain("may be truncated at opencode's 200-result ceiling");
    expect(r.exitCode).toBe(0);
  });

  it("find: limit:200 with exactly 200 real matches — still flagged 'may be' truncated (can't distinguish from more)", async () => {
    let seen: any;
    const rows = Array.from({ length: 200 }, (_, i) => `f${i}.ts`);
    const client = { find: { files: async (o: any) => ((seen = o), { data: rows }) } };
    const r = await run(client, { tool: "find", pattern: "*.ts", limit: 200 });
    // Byte-identical response to the 250-real-matches case above: the client
    // has no way to tell these two situations apart, so it must warn in both.
    expect(seen.query.limit).toBe(200);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderr).toContain("may be truncated at opencode's 200-result ceiling");
  });

  it("find: limit:199 with 250 real matches — the peek has room and gives a definite (not merely 'may be') truncation signal", async () => {
    let seen: any;
    // probeLimit = min(199+1,200) = 200, so the server (capped at 200) hands
    // back 200 rows — one more than effectiveLimit(199), which definitively
    // proves more than 199 matches exist.
    const rows = Array.from({ length: 200 }, (_, i) => `f${i}.ts`);
    const client = { find: { files: async (o: any) => ((seen = o), { data: rows }) } };
    const r = await run(client, { tool: "find", pattern: "*.ts", limit: 199 });
    expect(seen.query.limit).toBe(200);
    expect(r.stdout.split("\n")).toHaveLength(199);
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderr).toContain("more than 199 matches exist");
    expect(r.stderr).not.toContain("may be truncated");
  });

  // I2 (review round 1): a `path`-scoped find that comes back empty after
  // client-side filtering, while the root-wide fetch itself was full, never
  // actually got far enough to certify "no matches in scope" — that's not
  // "ran, found nothing" (exit 1), it's "didn't cover the scope" (exit 2),
  // so a HIGH_CONFIDENCE `exitCode` edge can't mistake it for a true miss.
  it("find: a scoped search that comes up empty while the root-wide fetch was full is exit 2, not a silent miss", async () => {
    mkdirSync(join(repo, "src2"), { recursive: true });
    // Every row the server returns sits OUTSIDE "src2/" even though the
    // root-wide fetch filled its entire probe window (101 rows for the
    // default limit of 100) — the search never got far enough to look inside
    // "src2/" at all.
    const rows = Array.from({ length: 101 }, (_, i) => `other/f${i}.ts`);
    const client = { find: { files: async () => ({ data: rows }) } };
    const r = await run(client, { tool: "find", pattern: "*.ts", path: "src2" });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("did not cover");
    expect(r.stderr).toContain("src2");
  });

  it("find: a scoped search with SOME matches while the root-wide fetch was full stays exit 0 + truncated (unchanged)", async () => {
    mkdirSync(join(repo, "src2"), { recursive: true });
    const rows = [
      ...Array.from({ length: 98 }, (_, i) => `other/f${i}.ts`),
      "src2/a.ts",
      "src2/b.ts",
      "src2/c.ts",
    ];
    const client = { find: { files: async () => ({ data: rows }) } };
    const r = await run(client, { tool: "find", pattern: "*.ts", path: "src2" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split("\n")).toEqual(["src2/a.ts", "src2/b.ts", "src2/c.ts"]);
    expect(r.stdoutTruncated).toBe(true);
  });

  // R34 Minor 5 (review round 1): a path that resolves outside the session
  // root (an existing directory, just not under it) must refuse explicitly —
  // not silently search-and-miss.
  it("find: a `path` that resolves outside the session root is an explicit exit-2 refusal", async () => {
    const client = { find: { files: async () => { throw new Error("SDK should not be called"); } } };
    const r = await run(client, { tool: "find", pattern: "*.ts", path: ".." });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("outside session root");
  });

  it("grep: a `path` that resolves outside the session root is an explicit exit-2 refusal", async () => {
    const client = { find: { text: async () => { throw new Error("SDK should not be called"); } } };
    const r = await run(client, { tool: "grep", pattern: "x", path: ".." });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("outside session root");
  });

  // Fix round 2 (review): the outside-root check must be realpath-aware, not
  // bare lexical `startsWith` — a session root and a `path` can each be
  // spelled through a different alias of the SAME real directory (macOS's
  // /var vs /private/var, or any symlinked root), and lexical comparison
  // alone would wrongly refuse those as "outside".
  it("grep: a session root and path expressed through DIFFERENT aliases of the SAME real directory are allowed (not refused)", async () => {
    const root = mkdtempSync(join(tmpdir(), "px-oc-alias-"));
    mkdirSync(join(root, "sub"));
    const realRoot = realpathSync(root);
    // realRoot differs lexically from `root` on macOS (/private/var vs
    // /var) — if it doesn't on this machine, the alias case can't be
    // exercised, so skip rather than produce a false pass/fail either way.
    if (realRoot === root) return;
    const client = { find: { text: async () => ({ data: [{ path: { text: "sub/a.ts" }, lines: { text: "x" }, line_number: 1 }] }) } };
    const executor = createToolExecutor(client as any, root);
    // `directory` is the LEXICAL (/var) root; `path` is the SAME subdirectory
    // spelled through the REALPATH (/private/var) alias.
    const r = await executor({ tool: "grep", pattern: "x", path: join(realRoot, "sub") }, { cwd: root });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("sub/a.ts:1:x");
  });

  it("find: a session root and path expressed through DIFFERENT aliases of the SAME real directory are allowed (not refused)", async () => {
    const root = mkdtempSync(join(tmpdir(), "px-oc-alias-"));
    mkdirSync(join(root, "sub"));
    const realRoot = realpathSync(root);
    if (realRoot === root) return;
    const client = { find: { files: async () => ({ data: ["sub/a.ts"] }) } };
    const executor = createToolExecutor(client as any, root);
    // Reverse direction: `directory` is the REALPATH (/private/var) root;
    // `path` is spelled through the LEXICAL (/var) alias.
    const r = await executor({ tool: "find", pattern: "*.ts", path: root }, { cwd: realRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("sub/a.ts");
  });

  it("grep: a symlinked subdirectory pointing OUTSIDE the session root is refused, even though it's lexically inside", async () => {
    const root = mkdtempSync(join(tmpdir(), "px-oc-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "px-oc-outside-"));
    writeFileSync(join(outside, "secret.ts"), "x");
    symlinkSync(outside, join(root, "escape"));
    const client = { find: { text: async () => { throw new Error("SDK should not be called"); } } };
    const executor = createToolExecutor(client as any, root);
    const r = await executor({ tool: "grep", pattern: "x", path: "escape" }, { cwd: root });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("outside session root");
  });

  it("find: a symlinked subdirectory pointing OUTSIDE the session root is refused, even though it's lexically inside", async () => {
    const root = mkdtempSync(join(tmpdir(), "px-oc-symlink-"));
    const outside = mkdtempSync(join(tmpdir(), "px-oc-outside-"));
    writeFileSync(join(outside, "secret.ts"), "x");
    symlinkSync(outside, join(root, "escape"));
    const client = { find: { files: async () => { throw new Error("SDK should not be called"); } } };
    const executor = createToolExecutor(client as any, root);
    const r = await executor({ tool: "find", pattern: "*.ts", path: "escape" }, { cwd: root });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("outside session root");
  });

  it("grep: a sibling directory sharing the root's name as a prefix (`<root>2`) is refused, not treated as inside", async () => {
    const root = mkdtempSync(join(tmpdir(), "px-oc-root-"));
    const sibling = `${root}2`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, "secret.ts"), "x");
    const client = { find: { text: async () => { throw new Error("SDK should not be called"); } } };
    const executor = createToolExecutor(client as any, root);
    const r = await executor({ tool: "grep", pattern: "x", path: sibling }, { cwd: root });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("outside session root");
  });

  it("find: a sibling directory sharing the root's name as a prefix (`<root>2`) is refused, not treated as inside", async () => {
    const root = mkdtempSync(join(tmpdir(), "px-oc-root-"));
    const sibling = `${root}2`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, "secret.ts"), "x");
    const client = { find: { files: async () => { throw new Error("SDK should not be called"); } } };
    const executor = createToolExecutor(client as any, root);
    const r = await executor({ tool: "find", pattern: "*.ts", path: sibling }, { cwd: root });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("outside session root");
  });

  it("grep: warns when opencode's hard 10-match cap may have truncated results", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => matchRow(`f${i}.ts`, i + 1));
    const client = { find: { text: async () => ({ data: rows }) } };
    const r = await run(client, { tool: "grep", pattern: "x" });
    // The cap is server-side and unraisable, so a full page is indistinguishable
    // from a truncated one — the model has to be told rather than left to assume.
    expect(r.stderr).toContain("caps results at 10");
    expect(r.exitCode).toBe(0);
  });

  it("grep: stays quiet when results are below the cap", async () => {
    const client = { find: { text: async () => ({ data: [matchRow("a.ts", 1)] }) } };
    const r = await run(client, { tool: "grep", pattern: "x" });
    expect(r.stderr).toBe("");
  });

  // R34 Minor 4 (review round 1): both a caller `limit` AND the host's
  // 10-match cap can be hit at once — the host-cap explanation must not be
  // dropped just because the caller-limit one also applies.
  it("grep: reports BOTH the caller-limit and host-cap explanations when both apply", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => matchRow(`f${i}.ts`, i + 1));
    const client = { find: { text: async () => ({ data: rows }) } };
    const r = await run(client, { tool: "grep", pattern: "x", limit: 5 });
    expect(r.stdout.split("\n")).toHaveLength(5);
    expect(r.stderr).toContain("caller limit 5 reached");
    expect(r.stderr).toContain("caps results at 10");
    expect(r.stdoutTruncated).toBe(true);
  });

  // I2 (review round 1): a `path`-scoped grep that comes back empty after
  // client-side filtering, while the root-wide fetch hit its un-raisable
  // 10-match cap, never actually got far enough to certify "no matches in
  // scope" — exit 2 ("didn't cover the scope"), not exit 1 ("ran, found
  // nothing"), so a HIGH_CONFIDENCE `exitCode` edge can't mistake it for a
  // true miss.
  it("grep: a scoped search that comes up empty while the host cap was hit is exit 2, not a silent miss", async () => {
    mkdirSync(join(repo, "src2"), { recursive: true });
    const rows = Array.from({ length: 10 }, (_, i) => matchRow(`other/f${i}.ts`, i + 1));
    const client = { find: { text: async () => ({ data: rows }) } };
    const r = await run(client, { tool: "grep", pattern: "x", path: "src2" });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("did not cover");
    expect(r.stderr).toContain("src2");
  });

  it("grep: a scoped search with SOME matches while the host cap was hit stays exit 0 + truncated (unchanged)", async () => {
    mkdirSync(join(repo, "src2"), { recursive: true });
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => matchRow(`other/f${i}.ts`, i + 1)),
      matchRow("src2/a.ts", 1),
      matchRow("src2/b.ts", 2),
    ];
    const client = { find: { text: async () => ({ data: rows }) } };
    const r = await run(client, { tool: "grep", pattern: "x", path: "src2" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split("\n")).toEqual(["src2/a.ts:1:const x = 1", "src2/b.ts:2:const x = 1"]);
    expect(r.stdoutTruncated).toBe(true);
  });

  it("ls: `limit` slices entries", async () => {
    const client = {
      file: { list: async () => ({ data: [{ name: "a" }, { name: "b" }, { name: "c" }] }) },
    };
    const r = await run(client, { tool: "ls", path: "src", limit: 2 });
    expect(r.stdout).toBe("a\nb");
  });
});

describe.each(variants)("opencode createToolExecutor ($name) — missing-path pre-check", ({ createToolExecutor }) => {
  const run = (client: any, op: ToolOp) =>
    createToolExecutor(client, repo)(op, { cwd: repo });

  // Without the pre-check, opencode's server hides missing paths: file.read
  // returns empty content with no error (silent false success) and file.list
  // throws an opaque 500. Both must instead fail with the resolved location.
  const sdkNeverCalled = {
    file: {
      read: async () => { throw new Error("SDK should not be called"); },
      list: async () => { throw new Error("SDK should not be called"); },
    },
  };

  it("read of a missing file => exit 1 with the resolved location", async () => {
    const r = await run(sdkNeverCalled, { tool: "read", path: "nope/absent.ts" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe(`path not found: nope/absent.ts (resolved against ${repo})`);
  });

  it("ls of a missing dir => exit 1 with the resolved location", async () => {
    const r = await run(sdkNeverCalled, { tool: "ls", path: "core/" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("path not found: core/");
    expect(r.stderr).toContain(repo);
  });

  it("absolute paths are checked as-is", async () => {
    const r = await run(sdkNeverCalled, { tool: "read", path: "/definitely/not/here.ts" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("path not found: /definitely/not/here.ts");
  });

  it("existing paths still route to the SDK client", async () => {
    const client = { file: { list: async () => ({ data: [{ name: "a.ts" }] }) } };
    const r = await run(client, { tool: "ls", path: "src" });
    expect(r).toEqual({ stdout: "a.ts", stderr: "", exitCode: 0 });
  });
});

describe.each(variants)("opencode plugin ($name) — host permission policy e2e", ({ plugin }) => {
  isolateOpencodeEnv();
  const execute = async (directory: string, plan: unknown) => {
    const hooks = await plugin.server({ client: {} } as any);
    return (hooks as any).tool.predexec.execute(
      { plan },
      { directory, abort: new AbortController().signal },
    );
  };
  const catPlan = { root: "a", nodes: [{ id: "a", commands: ["cat marker.txt"] }] };

  it("a project opencode.json deny rule hard-stops the matching command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "px-oc-policy-"));
    writeFileSync(join(dir, "opencode.json"), '{"permission":{"bash":{"cat *":"deny"}}}');
    writeFileSync(join(dir, "marker.txt"), "x");
    const out = await execute(dir, catPlan);
    expect(out).toContain("POLICY HARD-STOP (not run)");
    expect(out).toContain("'cat *'");
    expect(out).not.toContain("node a (exit");
  });

  it.each([
    "if true; then curl https://example.invalid/x; fi",
    "f() { curl https://example.invalid/x; }; f",
    "echo $(curl https://example.invalid/x)",
    "case x in y) { curl https://example.invalid/x; } ;; esac",
    "( curl https://example.invalid/x )",
  ])("a deny rule hard-stops curl nested in executable syntax: %s", async (command) => {
    const dir = mkdtempSync(join(tmpdir(), "px-oc-policy-"));
    writeFileSync(join(dir, "opencode.json"), '{"permission":{"bash":{"curl *":"deny"}}}');
    const out = await execute(dir, { root: "a", nodes: [{ id: "a", commands: [command] }] });
    expect(out).toContain("POLICY HARD-STOP (not run)");
    expect(out).toContain("'curl *'");
    expect(out).not.toContain("node a (exit");
  });

  it("a project opencode.json read rule hard-stops a native read operation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "px-oc-policy-"));
    writeFileSync(join(dir, "opencode.json"), '{"permission":{"read":{"*":"allow",".env":"deny"}}}');
    const out = await execute(dir, { root: "a", nodes: [{ id: "a", commands: [{ tool: "read", path: ".env" }] }] });
    expect(out).toContain("POLICY HARD-STOP (not run)");
    expect(out).toContain("read:.env");
  });

  it("matches a native read rule relative to the session root under plan cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "px-oc-policy-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", ".env"), "nested secret");
    writeFileSync(join(dir, "opencode.json"), '{"permission":{"read":{"sub/.env":"deny"}}}');
    const out = await execute(dir, { root: "a", cwd: "sub", nodes: [{ id: "a", commands: [{ tool: "read", path: ".env" }] }] });
    expect(out).toContain("POLICY HARD-STOP (not run)");
    expect(out).not.toContain("nested secret");
  });

  it("matches a native glob rule against the requested pattern under plan cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "px-oc-policy-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "opencode.json"), '{"permission":{"glob":{"README.md":"deny"}}}');
    const out = await execute(dir, {
      root: "a",
      cwd: "sub",
      nodes: [{ id: "a", commands: [{ tool: "find", path: ".", pattern: "README.md" }] }],
    });
    expect(out).toContain("POLICY HARD-STOP (not run)");
    expect(out).toContain("'glob:README.md'");
  });

  it("without a permission block the same plan runs normally", async () => {
    const dir = mkdtempSync(join(tmpdir(), "px-oc-policy-"));
    writeFileSync(join(dir, "opencode.json"), "{}");
    writeFileSync(join(dir, "marker.txt"), "x");
    const out = await execute(dir, catPlan);
    expect(out).toContain("node a (exit 0)");
  });

  it("returns a readable coercion error on malformed plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "px-oc-policy-"));
    const out = await execute(dir, { bad: "plan" });
    expect(out).toContain("predexec expected a JSON object with `root`");
  });

  it("returns a readable error on invalid plan cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "px-oc-policy-"));
    const out = await execute(dir, { root: "a", nodes: [{ id: "a", commands: ["echo"] }], cwd: 123 });
    expect(out).toContain("cwd must be a relative directory inside the session root");
  });

  it.each([
    { root: "a", nodes: [{ id: "a", commands: [null] }] },
    { root: "a", nodes: [{ id: "a", commands: [42] }] },
    { root: "a", nodes: [{ id: "a", commands: [[]] }] },
    { root: "a", nodes: [{ id: "a", commands: [{ path: "x" }] }] },
    { root: "a", nodes: [{ id: "a", commands: [{ tool: "unknown" }] }] },
    { root: "a", nodes: [{ id: "a", commands: [{ tool: "bash", command: 42 }] }] },
    { root: "a", nodes: [{ id: "a", commands: [{ tool: "read", path: 42 }] }] },
    { root: "a", nodes: [{ id: "a", commands: [{ tool: "grep", pattern: [] }] }] },
  ])("returns a validation error for malformed operation %j", async (plan) => {
    const dir = mkdtempSync(join(tmpdir(), "px-oc-validation-"));
    const out = await execute(dir, plan);
    expect(out).toContain("plan validation failed");
    expect(out).not.toContain("node a (exit");
  });
});

describe.each(variants)("opencode plugin ($name) — host context.ask bridge", ({ plugin }) => {
  isolateOpencodeEnv();
  const execute = async (directory: string, plan: unknown, ask?: (input: any) => Promise<void>) => {
    const hooks = await plugin.server({ client: {} } as any);
    return (hooks as any).tool.predexec.execute(
      { plan },
      { directory, worktree: directory, agent: "build", abort: new AbortController().signal, ...(ask ? { ask } : {}) },
    );
  };
  const project = (config: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "px-oc-ask-"));
    writeFileSync(join(dir, "opencode.json"), JSON.stringify(config));
    writeFileSync(join(dir, "marker.txt"), "x");
    return dir;
  };
  const catPlan = { root: "a", nodes: [{ id: "a", commands: ["cat marker.txt"] }] };

  it("a static ask rule defers to context.ask; approval runs the command", async () => {
    const dir = project({ permission: { bash: { "cat *": "ask" } } });
    const asks: any[] = [];
    const out = await execute(dir, catPlan, async (input) => {
      asks.push(input);
    });
    expect(out).toContain("node a (exit 0)");
    expect(asks).toEqual([
      { permission: "bash", patterns: ["cat marker.txt"], always: [], metadata: { source: "predexec", operation: "cat marker.txt" } },
    ]);
  });

  it("a context.ask rejection is a policy stop naming opencode's reason", async () => {
    const dir = project({});
    const out = await execute(dir, catPlan, async () => {
      throw new Error("The user rejected permission to use this specific tool call.");
    });
    expect(out).toContain("POLICY HARD-STOP (not run)");
    expect(out).toContain("opencode denied permission: The user rejected permission");
    expect(out).not.toContain("host permission rule");
    expect(out).not.toContain("node a (exit");
  });

  it("a static deny stops without prompting even when context.ask exists", async () => {
    const dir = project({ permission: { bash: { "cat *": "deny" } } });
    let asked = false;
    const out = await execute(dir, catPlan, async () => {
      asked = true;
    });
    expect(out).toContain("'cat *'");
    expect(asked).toBe(false);
  });

  it("without context.ask a static ask still hard-stops", async () => {
    const dir = project({ permission: { bash: { "cat *": "ask" } } });
    const out = await execute(dir, catPlan);
    expect(out).toContain("POLICY HARD-STOP (not run)");
  });

  it("the session agent's permission block applies", async () => {
    const dir = project({ agent: { build: { permission: { bash: { "cat *": "deny" } } } } });
    const out = await execute(dir, catPlan);
    expect(out).toContain("'cat *'");
  });
});

describe.each(variants)("opencode plugin ($name) — prompting surfaces", ({ plugin }) => {
  it("tool description carries the verify-first guideline", async () => {
    const hooks = await plugin.server({ client: {} } as any);
    const def = (hooks as any).tool.predexec;
    expect(def.description).toContain("Do not build depth on unverified paths");
    expect(def.description).toContain("# cwd:");
  });

  it("plan arg description teaches the condition string shorthands", async () => {
    const hooks = await plugin.server({ client: {} } as any);
    const def = (hooks as any).tool.predexec;
    const desc = def.args.plan.description ?? "";
    expect(desc).toContain('"exit == 0"');
    expect(desc).toContain('"stdout =~ /regex/"');
    expect(desc).toContain('"file exists <path>"');
    expect(desc).toContain('"always"');
    expect(desc).toContain(PLAN_SHAPE_DESCRIPTION);
  });
});

describe.each(variants)("opencode plugin ($name) — system.transform no-op for non-chat prompts", ({ plugin }) => {
  const transform = async (input: unknown) => {
    const hooks = await plugin.server({ client: {} } as any);
    const output = { system: ["existing system prompt"] };
    await (hooks as any)["experimental.chat.system.transform"](input, output);
    return output;
  };

  // opencode 1.18.32 fires this hook from exactly two call sites:
  //  - session/llm/request.ts:56-72 (`prepare()`, used for every chat turn —
  //    and, with `small:true`, for in-session "small" completions such as
  //    title generation too) always includes `sessionID`.
  //  - agent/agent.ts:381 (`Agent.generate`, which synthesizes a NEW agent
  //    config from a natural-language description and is instructed to
  //    "Return ONLY the JSON object, no other text") fires with NO `sessionID`
  //    at all. `sessionID` presence is the only field the hook's documented
  //    input shape (`{ sessionID?: string; model: Model }`,
  //    packages/plugin/src/index.ts:292) exposes to tell the two apart.
  it("is a no-op for a sessionID-less input (agent.ts:381's Agent.generate)", async () => {
    const output = await transform({ model: { id: "m" } });
    expect(output.system).toEqual(["existing system prompt"]);
  });

  it("still injects the routing line for a real chat turn (sessionID present, request.ts:70-72)", async () => {
    const output = await transform({ sessionID: "ses_1", model: { id: "m" } });
    expect(output.system).toContain(STEERING_LINE);
  });

  it("treats an empty-string sessionID the same as absent", async () => {
    const output = await transform({ sessionID: "", model: { id: "m" } });
    expect(output.system).toEqual(["existing system prompt"]);
  });
});

describe.each(variants)("opencode plugin ($name) — system.transform defers to the packaged skill", ({ plugin }) => {
  // Simulates the real <available_skills> block opencode's own system prompt
  // builder renders once the config-hook-registered skill is discovered
  // (skill/index.ts fmt(), verbose mode: name + description + location only —
  // see session/system.ts:107-118). The quorum check must recognize predexec's
  // OWN generated skill description as routing instructions already present,
  // not just a hand-written AGENTS.md block.
  const skillDescription = (() => {
    const match = renderSkill("opencode").match(/^description: (.+)$/m);
    if (!match) throw new Error("opencode SKILL.md is missing a description frontmatter line");
    return match[1];
  })();

  it("skips injection when the system prompt already carries the generated <available_skills> description", async () => {
    const hooks = await plugin.server({ client: {} } as any);
    const output = {
      system: [
        "<available_skills>\n" +
          "  <skill>\n" +
          "    <name>predexec</name>\n" +
          `    <description>${skillDescription}</description>\n` +
          "    <location>/wherever/skills/opencode/predexec/SKILL.md</location>\n" +
          "  </skill>\n" +
          "</available_skills>",
      ],
    };
    await (hooks as any)["experimental.chat.system.transform"]({ sessionID: "ses_1", model: { id: "m" } }, output);
    // SKILL_DESCRIPTION is built FROM STEERING_LINE (it's a literal prefix of
    // it), so asserting on substring absence would be trivially wrong here —
    // the array staying at length 1 (nothing pushed) is the real assertion
    // that injection was skipped.
    expect(output.system).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// opencode v2 (2.0.x) plugin API
// ---------------------------------------------------------------------------

/**
 * Transcription of opencode 1.18.32's `readV1Plugin(mod, spec, "server", "detect")`
 * (packages/opencode/src/plugin/shared.ts:272-304): the default export must be
 * an object; extra keys are never inspected. Returns the value it would use.
 */
const v1LoaderRead = (mod: Record<string, unknown>) => {
  const value = mod.default as Record<string, unknown> | undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("must default export an object with server()");
  if (!("id" in value) && !("server" in value) && !("tui" in value)) return undefined;
  const server = "server" in value ? value.server : undefined;
  const tui = "tui" in value ? value.tui : undefined;
  if (server !== undefined && typeof server !== "function") throw new TypeError("invalid server export");
  if (tui !== undefined && typeof tui !== "function") throw new TypeError("invalid tui export");
  if (server !== undefined && tui !== undefined) throw new TypeError("either server() or tui(), not both");
  if (server === undefined) throw new TypeError("must default export an object with server()");
  return value;
};

/**
 * Transcription of opencode 2.0.16's `PluginModule` decode
 * (packages/core/src/plugin/module.ts:60-73,107-116): `default` must decode as
 * `{id: string, effect: fn}` or `{id: string, setup: fn}` — an Effect
 * `Schema.Struct` union whose default `onExcessProperty: "ignore"` STRIPS every
 * other key (effect 4.0.0-rc.112 SchemaAST.ts:445). The decoded (stripped)
 * object is what the host then calls, so `setup` must not depend on `this`.
 */
const v2LoaderDecode = (mod: Record<string, unknown>) => {
  const value = mod.default as Record<string, unknown> | undefined;
  const fail = () => {
    throw new Error('Plugin must export a default definition with an id and an effect or setup function. Missing key ["default"]["effect"] Missing key ["default"]["setup"]');
  };
  if (value === null || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string") return fail();
  if (typeof value.effect === "function") return { id: value.id, effect: value.effect as Function };
  if (typeof value.setup === "function") return { id: value.id, setup: value.setup as (ctx: unknown) => unknown };
  return fail();
};

/** A recording stand-in for the opencode v2 Promise plugin context the adapter touches. */
const fakeV2Context = (directory: string, projectDirectory = directory) => {
  const toolTransforms: Array<(editor: any) => void> = [];
  const skillTransforms: Array<(editor: any) => void> = [];
  const sessionHooks: Record<string, Array<(event: any) => unknown>> = {};
  const toolHooks: Record<string, Array<(event: any) => unknown>> = {};
  const registration = { dispose: async () => {} };
  const ctx = {
    app: { name: "opencode", version: "2.0.16", channel: "latest" },
    location: { directory, project: { id: "p", directory: projectDirectory, canonical: projectDirectory } },
    options: {},
    tool: {
      transform: async (cb: (editor: any) => void) => (toolTransforms.push(cb), registration),
      hook: async (name: string, cb: (event: any) => unknown) => ((toolHooks[name] ??= []).push(cb), registration),
    },
    skill: { transform: async (cb: (editor: any) => void) => (skillTransforms.push(cb), registration) },
    session: {
      hook: async (name: string, cb: (event: any) => unknown) => ((sessionHooks[name] ??= []).push(cb), registration),
    },
  };
  const tools = () => {
    const added: any[] = [];
    for (const cb of toolTransforms) cb({ add: (t: any) => added.push(t), list: () => added, get: () => undefined, namespace() {}, update() {}, remove() {} });
    return added;
  };
  const skills = () => {
    const added: any[] = [];
    for (const cb of skillTransforms) cb({ add: (s: any) => added.push(s), list: () => added, get: () => undefined, update() {}, remove() {} });
    return added;
  };
  return { ctx, tools, skills, sessionHooks, toolHooks };
};

const v2ToolContext = (agent = "build") => ({
  sessionID: "ses_1",
  agent,
  messageID: "msg_1",
  id: "call_1",
  signal: new AbortController().signal,
  progress: async () => {},
});

describe.each(variants)("opencode plugin ($name) — v2 loader contract", ({ plugin }) => {
  const mod = { default: plugin } as Record<string, unknown>;

  it("the ONE default export passes the v1 readV1Plugin shape check", () => {
    const read = v1LoaderRead(mod);
    expect(read).toBe(plugin);
    expect(typeof (read as any).server).toBe("function");
  });

  it("the SAME default export decodes under the v2 PluginModule schema as { id, setup }", () => {
    const decoded = v2LoaderDecode(mod);
    expect(decoded.id).toBe("predexec");
    expect(typeof (decoded as any).setup).toBe("function");
  });

  it("the v1 bare { id, server } shape is what v2.0.16 rejected (regression guard for the transcription)", () => {
    expect(() => v2LoaderDecode({ default: { id: "predexec", server: () => ({}) } })).toThrow(/effect.*setup/);
  });

  it("setup works when called detached from the export object (v2 calls the stripped decode)", async () => {
    const decoded = v2LoaderDecode(mod) as { setup: (ctx: unknown) => unknown };
    const dir = mkdtempSync(join(tmpdir(), "px-oc-v2-"));
    const fake = fakeV2Context(dir);
    const detached = decoded.setup;
    await detached(fake.ctx);
    expect(fake.tools().map((t) => t.name)).toEqual(["predexec"]);
  });
});

describe.each(variants)("opencode plugin ($name) — v2 setup registrations", ({ plugin }) => {
  const setupWith = async (dir = mkdtempSync(join(tmpdir(), "px-oc-v2-"))) => {
    const fake = fakeV2Context(dir);
    await (plugin as any).setup(fake.ctx);
    return fake;
  };

  it("registers the predexec tool on the native tool list with a JSON-Schema plan input", async () => {
    const fake = await setupWith();
    const [tool] = fake.tools();
    expect(tool.name).toBe("predexec");
    // codemode defaults true in v2 (core/src/tool/AGENTS.md "Registration"),
    // which would hide the tool behind CodeMode's `execute`; built-ins opt out.
    expect(tool.options).toEqual({ codemode: false });
    expect(tool.description).toContain("Do not build depth on unverified paths");
    expect(tool.input.type).toBe("object");
    expect(tool.input.properties.plan.description).toContain(PLAN_SHAPE_DESCRIPTION);
    expect(tool.input.properties.plan.description).toContain('"exit == 0"');
    // R42: the shared node:fs executor's exit codes differ from the v1 SDK path's.
    expect(tool.input.properties.plan.description).toMatch(/read\/ls 1 = failed/);
    expect(tool.input.properties.plan.description).toMatch(/opencode 1\.x every op that never ran exits 2/);
    // No zod on the v2 path: a zod instance would be introspected cross-instance
    // by the host's pinned zod 4.1.8 (core/src/tool/runtime.ts:165-169).
    expect(tool.input._zod).toBeUndefined();
    expect(tool.output).toBeUndefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("registers the packaged opencode skill through the skill domain", async () => {
    const fake = await setupWith();
    const skills = fake.skills();
    expect(skills).toHaveLength(1);
    const [skill] = skills;
    expect(skill.id).toBe("predexec");
    expect(skill.name).toBe("predexec");
    expect(skill.description).toBe(renderSkill("opencode").match(/^description: (.+)$/m)?.[1]);
    expect(skill.path).toMatch(/skills[\\/]opencode[\\/]predexec[\\/]SKILL\.md$/);
    expect(skill.content).not.toMatch(/^---/);
    expect(skill.content).toContain("# predexec routing (opencode)");
  });

  it("the session context hook injects the steering line as a system part when absent", async () => {
    const fake = await setupWith();
    expect(fake.sessionHooks.context).toHaveLength(1);
    const event = { sessionID: "ses_1", agent: "build", system: [{ type: "text", text: "existing" }] };
    await fake.sessionHooks.context![0]!(event);
    expect(event.system).toEqual([{ type: "text", text: "existing" }, { type: "text", text: STEERING_LINE }]);
  });

  it("the session context hook stays silent when the skill description already carries the routing rule", async () => {
    const fake = await setupWith();
    const description = renderSkill("opencode").match(/^description: (.+)$/m)?.[1] ?? "";
    const event = { sessionID: "ses_1", agent: "build", system: [{ type: "text", text: `<available_skills><skill><name>predexec</name><description>${description}</description></skill></available_skills>` }] };
    await fake.sessionHooks.context![0]!(event);
    expect(event.system).toHaveLength(1);
  });

  it("the tool execute.after hook nudges read-only shell and native read tools, not destructive shell", async () => {
    const fake = await setupWith();
    const after = fake.toolHooks["execute.after"]![0]!;
    const completed = (tool: string, input: unknown) => ({ tool, input, status: "completed", result: { content: "out" } }) as any;
    const read = completed("read", { filePath: "a" });
    await after(read);
    expect(read.result.content).toContain("predexec");
    const shell = completed("shell", { command: "ls" });
    await after(shell);
    expect(shell.result.content).toContain("predexec");
    const rm = completed("shell", { command: "rm -rf build" });
    await after(rm);
    expect(rm.result.content).toBe("out");
    const failed = { tool: "read", input: {}, status: "error", error: new Error("x") } as any;
    await after(failed);
    expect(failed.result).toBeUndefined();
  });
});

describe.each(variants)("opencode plugin ($name) — v2 tool execution + permission bridge", ({ plugin }) => {
  isolateOpencodeEnv();
  const project = (config?: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), "px-oc-v2-policy-"));
    if (config !== undefined) writeFileSync(join(dir, "opencode.json"), JSON.stringify(config));
    writeFileSync(join(dir, "marker.txt"), "marker-content");
    return dir;
  };
  const execute = async (dir: string, plan: unknown, agent = "build") => {
    const fake = fakeV2Context(dir);
    await (plugin as any).setup(fake.ctx);
    const [tool] = fake.tools();
    return tool.execute({ plan }, v2ToolContext(agent));
  };
  const catPlan = { root: "a", nodes: [{ id: "a", commands: ["cat marker.txt"] }] };

  it("runs a read-only plan against the location directory and returns the transcript as content", async () => {
    const dir = project();
    const out = await execute(dir, catPlan);
    expect(out.output).toBeUndefined();
    expect(out.content).toContain("node a (exit 0)");
    expect(out.content).toContain("marker-content");
  });

  it("native tool ops run through the node:fs executor rooted at the location directory", async () => {
    const dir = project();
    const out = await execute(dir, { root: "a", nodes: [{ id: "a", commands: [{ tool: "read", path: "marker.txt" }, { tool: "ls" }] }] });
    expect(out.content).toContain("marker-content");
    expect(out.content).toContain("marker.txt");
  });

  it("a v1-form permission deny rule hard-stops (v2 still migrates the v1 `permission` key)", async () => {
    const dir = project({ permission: { bash: { "cat *": "deny" } } });
    const out = await execute(dir, catPlan);
    expect(out.content).toContain("POLICY HARD-STOP (not run)");
    expect(out.content).toContain("'shell:cat *'");
    expect(out.content).not.toContain("marker-content");
  });

  it("an ask rule hard-stops: the v2 plugin context has no ask equivalent", async () => {
    const dir = project({ permission: { bash: { "cat *": "ask" } } });
    const out = await execute(dir, catPlan);
    expect(out.content).toContain("POLICY HARD-STOP (not run)");
    expect(out.content).not.toContain("marker-content");
  });

  it("the tool context's agent selects the agent permission block", async () => {
    const dir = project({ agent: { review: { permission: { bash: { "cat *": "deny" } } } } });
    expect((await execute(dir, catPlan, "review")).content).toContain("POLICY HARD-STOP (not run)");
    expect((await execute(dir, catPlan, "build")).content).toContain("node a (exit 0)");
  });

  it("v2-native top-level `permissions` are evaluated (last match wins) and can deny", async () => {
    const dir = project({ permissions: [{ action: "shell", resource: "cat *", effect: "deny" }] });
    const out = await execute(dir, catPlan);
    expect(out.content).toContain("POLICY HARD-STOP (not run)");
    expect(out.content).toContain("'shell:cat *'");
    expect(out.content).not.toContain("marker-content");
  });

  it("v2-native agent `permissions` apply to that agent only", async () => {
    const dir = project({ agents: { review: { permissions: [{ action: "shell", resource: "cat *", effect: "deny" }] } } });
    expect((await execute(dir, catPlan, "review")).content).toContain("POLICY HARD-STOP (not run)");
    expect((await execute(dir, catPlan, "build")).content).toContain("marker-content");
  });

  it("a deny from one config layer survives a later layer's catch-all (v2 concatenates, it does not mergeDeep)", async () => {
    const dir = project({ permission: { bash: { "*": "deny" } } });
    const cfg = join(process.env.XDG_CONFIG_HOME!, "opencode");
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, "opencode.json"), JSON.stringify({ permission: { bash: { "*": "deny", "cat *": "allow" } } }));
    const out = await execute(dir, catPlan);
    expect(out.content).toContain("POLICY HARD-STOP (not run)");
  });

  it("an unparseable native `permissions` entry stops every operation (fail-closed)", async () => {
    const dir = project({ permissions: [{ action: "shell", resource: "cat *", effect: "maybe" }] });
    const out = await execute(dir, catPlan);
    expect(out.content).toContain("POLICY HARD-STOP (not run)");
    expect(out.content).toContain("cannot read your opencode permission rules");
    expect(out.content).not.toContain("marker-content");
  });
});
