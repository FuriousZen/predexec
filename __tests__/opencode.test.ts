import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import plugin, { createToolExecutor, server } from "../.opencode/plugins/predexec.ts";
import type { ToolOp } from "../core/index.ts";

// read/ls pre-check path existence against the cwd, so mocked-client tests
// need a real directory with the paths their ops name.
const repo = mkdtempSync(join(tmpdir(), "px-opencode-"));
writeFileSync(join(repo, "a.ts"), "x");
mkdirSync(join(repo, "src"));
writeFileSync(join(repo, "src", "a.ts"), "x");

const run = (client: any, op: ToolOp) =>
  createToolExecutor(client, repo)(op, { cwd: repo });

describe("opencode plugin — loader contract", () => {
  // opencode's readV1Plugin loads ONLY the default export and requires
  // { server() }; a named-export-only module is silently skipped.
  it("default-exports { id, server } for current opencode loaders", () => {
    expect(plugin.id).toBe("predexec");
    expect(plugin.server).toBe(server);
    expect(typeof plugin.server).toBe("function");
  });

  it("server() registers the predexec tool with plain-object definition and hooks", async () => {
    const hooks = await server({ client: {} } as any);
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

describe("opencode createToolExecutor — SDK response mapping", () => {
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

describe("opencode createToolExecutor — grep/find arg handling", () => {
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

  it("find: `path` scopes and `limit` slices", async () => {
    let seen: any;
    const client = { find: { files: async (o: any) => ((seen = o), { data: ["a.ts", "b.ts", "c.ts"] }) } };
    const r = await run(client, { tool: "find", pattern: "*.ts", path: "src", limit: 1 });
    expect(seen.query.directory).toBe(join(repo, "src"));
    expect(r.stdout).toBe("a.ts");
  });

  it("ls: `limit` slices entries", async () => {
    const client = {
      file: { list: async () => ({ data: [{ name: "a" }, { name: "b" }, { name: "c" }] }) },
    };
    const r = await run(client, { tool: "ls", path: "src", limit: 2 });
    expect(r.stdout).toBe("a\nb");
  });
});

describe("opencode createToolExecutor — missing-path pre-check", () => {
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

describe("opencode plugin — prompting surfaces", () => {
  it("tool description carries the verify-first guideline", async () => {
    const hooks = await server({ client: {} } as any);
    const def = (hooks as any).tool.predexec;
    expect(def.description).toContain("Do not build depth on unverified paths");
    expect(def.description).toContain("# cwd:");
  });

  it("plan arg description teaches the condition string shorthands", async () => {
    const hooks = await server({ client: {} } as any);
    const def = (hooks as any).tool.predexec;
    const desc = def.args.plan.description ?? "";
    expect(desc).toContain('"exit == 0"');
    expect(desc).toContain('"stdout =~ /regex/"');
    expect(desc).toContain('"file exists <path>"');
    expect(desc).toContain('"always"');
  });
});
