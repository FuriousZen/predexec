import { describe, expect, it } from "vitest";
import plugin, { createToolExecutor, server } from "../.opencode/plugins/predexec.ts";
import type { ToolOp } from "../core/index.ts";

const run = (client: any, op: ToolOp) =>
  createToolExecutor(client, "/repo")(op, { cwd: "/repo" });

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
    expect(seen).toEqual({ query: { path: "src/a.ts", directory: "/repo" } });
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

  it("maps an SDK error to a non-zero exit", async () => {
    const client = { file: { read: async () => ({ error: "boom" }) } };
    const r = await run(client, { tool: "read", path: "a.ts" });
    expect(r).toEqual({ stdout: "", stderr: "boom", exitCode: 1 });
  });

  it("unknown tool => error result", async () => {
    const r = await run({}, { tool: "deploy" } as ToolOp);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown tool: deploy");
  });

  it("a thrown SDK call is caught and reported", async () => {
    const client = { file: { read: async () => { throw new Error("network down"); } } };
    const r = await run(client, { tool: "read", path: "a.ts" });
    expect(r).toEqual({ stdout: "", stderr: "network down", exitCode: 1 });
  });
});
