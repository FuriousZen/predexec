import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

// read/ls pre-check path existence against the cwd, so mocked-client tests
// need a real directory with the paths their ops name.
const repo = mkdtempSync(join(tmpdir(), "px-opencode-"));
writeFileSync(join(repo, "a.ts"), "x");
mkdirSync(join(repo, "src"));
writeFileSync(join(repo, "src", "a.ts"), "x");

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
      expect(result.exitCode).toBe(1);
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

  it("maps an SDK error to a non-zero exit, attributed to the op", async () => {
    const client = { file: { read: async () => ({ error: "boom" }) } };
    const r = await run(client, { tool: "read", path: "a.ts" });
    expect(r).toEqual({ stdout: "", stderr: "read a.ts: boom", exitCode: 1 });
  });

  it("unknown tool => error result", async () => {
    const r = await run({}, { tool: "deploy" } as ToolOp);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown tool: deploy");
  });

  it("a thrown SDK call is caught and reported", async () => {
    const client = { file: { read: async () => { throw new Error("network down"); } } };
    const r = await run(client, { tool: "read", path: "a.ts" });
    expect(r).toEqual({ stdout: "", stderr: "read: network down", exitCode: 1 });
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

  it("grep: `path` scopes the SDK query to the resolved directory", async () => {
    let seen: any;
    const client = { find: { text: async (o: any) => ((seen = o), { data: [matchRow("a.ts", 1)] }) } };
    const r = await run(client, { tool: "grep", pattern: "x", path: "src" });
    expect(seen.query.directory).toBe(join(repo, "src"));
    expect(r.exitCode).toBe(0);
  });

  it("grep: a FILE `path` fails loudly instead of silently searching the repo", async () => {
    const client = { find: { text: async () => ({ data: [] }) } };
    const r = await run(client, { tool: "grep", pattern: "x", path: "a.ts" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('"a.ts" is a file');
  });

  it("grep: a missing `path` fails with the resolved location", async () => {
    const client = { find: { text: async () => ({ data: [] }) } };
    const r = await run(client, { tool: "grep", pattern: "x", path: "nope/" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("path not found: nope/");
  });

  it("grep: unsupported args error loudly, naming them", async () => {
    const client = { find: { text: async () => ({ data: [] }) } };
    const r = await run(client, { tool: "grep", pattern: "x", glob: "*.ts", ignoreCase: true });
    expect(r.exitCode).toBe(1);
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

  it("find: `path` scopes, and the limit is sent server-side as well as sliced", async () => {
    let seen: any;
    const client = { find: { files: async (o: any) => ((seen = o), { data: ["a.ts", "b.ts", "c.ts"] }) } };
    const r = await run(client, { tool: "find", pattern: "*.ts", path: "src", limit: 1 });
    expect(seen.query.directory).toBe(join(repo, "src"));
    // Regression: omitting `limit` from the query let opencode apply its own
    // default of 10, silently truncating every larger result set.
    expect(seen.query.limit).toBe(1);
    expect(r.stdout).toBe("a.ts");
  });

  it("find: sends a limit above opencode's default of 10 when the op omits one", async () => {
    let seen: any;
    const client = { find: { files: async (o: any) => ((seen = o), { data: [] }) } };
    await run(client, { tool: "find", pattern: "*.ts" });
    expect(seen.query.limit).toBeGreaterThan(10);
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
    expect(out).toContain("'README.md'");
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
