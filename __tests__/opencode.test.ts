import { describe, expect, it } from "vitest";
import { createToolExecutor } from "../.opencode/plugins/predexec.ts";
import type { ToolOp } from "../core/index.ts";

const run = (client: any, op: ToolOp) =>
  createToolExecutor(client, "/repo")(op, { cwd: "/repo" });

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
