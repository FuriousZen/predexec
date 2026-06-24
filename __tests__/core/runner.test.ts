import { describe, expect, it } from "vitest";
import { runNode, isToolOp, formatToolOpLabel } from "../../core/runner.ts";
import type { ToolOp, RunOptions } from "../../core/types.ts";

const cwd = process.cwd();

const mockToolExecutor = async (op: ToolOp) => {
  if (op.tool === "read") return { stdout: `content of ${op.path}`, stderr: "", exitCode: 0 };
  if (op.tool === "grep") return { stdout: `match in ${op.path}`, stderr: "", exitCode: 0 };
  if (op.tool === "fail") return { stdout: "", stderr: "tool failed", exitCode: 1 };
  return { stdout: "", stderr: `unknown: ${op.tool}`, exitCode: 1 };
};

describe("isToolOp / formatToolOpLabel", () => {
  it("identifies tool ops vs strings", () => {
    expect(isToolOp("echo hi")).toBe(false);
    expect(isToolOp({ tool: "read", path: "foo.ts" })).toBe(true);
    expect(isToolOp({ notATool: true })).toBe(false);
    expect(isToolOp(null as any)).toBe(false);
  });

  it("formats labels with primary arg", () => {
    expect(formatToolOpLabel({ tool: "read", path: "src/foo.ts" })).toBe("read:src/foo.ts");
    expect(formatToolOpLabel({ tool: "grep", pattern: "TODO" })).toBe("grep:TODO");
    expect(formatToolOpLabel({ tool: "ls" })).toBe("ls");
  });
});

describe("runNode — tool ops", () => {
  const opts: RunOptions = { cwd, executeToolOp: mockToolExecutor };

  it("executes a tool op and captures output", async () => {
    const r = await runNode({ id: "n", commands: [{ tool: "read", path: "foo.ts" }] }, opts);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("content of foo.ts");
  });

  it("mixes shell commands and tool ops in sequence", async () => {
    const r = await runNode(
      { id: "n", commands: ["echo shell", { tool: "read", path: "bar.ts" }] },
      opts,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("shell");
    expect(r.stdout).toContain("content of bar.ts");
  });

  it("stop-on-first-error applies to tool ops", async () => {
    const r = await runNode(
      { id: "n", commands: [{ tool: "fail" }, "echo SHOULD_NOT_RUN"] },
      opts,
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout).not.toContain("SHOULD_NOT_RUN");
  });

  it("runs tool ops in parallel when parallel:true", async () => {
    const r = await runNode(
      { id: "n", commands: [{ tool: "read", path: "a.ts" }, { tool: "read", path: "b.ts" }], parallel: true },
      opts,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("content of a.ts");
    expect(r.stdout).toContain("content of b.ts");
  });

  it("returns error when no tool executor is provided", async () => {
    const r = await runNode({ id: "n", commands: [{ tool: "read", path: "x" }] }, { cwd });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no tool executor");
  });
});

describe("runNode", () => {
  it("runs a single command and captures stdout + exit code", async () => {
    const r = await runNode({ id: "n", commands: ["echo hello"] }, { cwd });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello");
  });

  it("captures a non-zero exit code", async () => {
    const r = await runNode({ id: "n", commands: ["exit 3"] }, { cwd });
    expect(r.exitCode).toBe(3);
  });

  it("stops sequential batch on first error (stop-on-first-error)", async () => {
    const r = await runNode({ id: "n", commands: ["exit 2", "echo SHOULD_NOT_RUN"] }, { cwd });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).not.toContain("SHOULD_NOT_RUN");
  });

  it("runs all commands in a successful sequential batch", async () => {
    const r = await runNode({ id: "n", commands: ["echo a", "echo b"] }, { cwd });
    expect(r.stdout).toContain("a");
    expect(r.stdout).toContain("b");
    expect(r.exitCode).toBe(0);
  });

  it("runs commands concurrently when parallel and aggregates a failure", async () => {
    const r = await runNode({ id: "n", commands: ["echo p", "exit 7"], parallel: true }, { cwd });
    expect(r.stdout).toContain("p");
    expect(r.exitCode).toBe(7); // the failing command's code surfaces
  });

  it("returns immediately for an already-aborted signal", async () => {
    const r = await runNode({ id: "n", commands: ["echo nope"] }, { cwd, signal: AbortSignal.abort() });
    expect(r.stdout).not.toContain("nope");
  });
});
