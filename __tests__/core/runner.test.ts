import { describe, expect, it } from "vitest";
import { runNode, isToolOp, formatToolOpLabel, OUTPUT_CAP } from "../../core/runner.ts";
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

  it("marks truncation when a tool returns more than the output cap", async () => {
    const r = await runNode(
      { id: "n", commands: [{ tool: "read", path: "huge.txt" }] },
      {
        cwd,
        executeToolOp: async () => ({ stdout: "x".repeat(OUTPUT_CAP + 1), stderr: "", exitCode: 0 }),
      },
    );
    expect(r.stdout).toContain("…[truncated");
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderrTruncated).toBe(false);
  });

  it("propagates semantic truncation from a bounded tool result", async () => {
    const r = await runNode(
      { id: "n", commands: [{ tool: "read", path: "large.txt", limit: 1 }] },
      {
        cwd,
        executeToolOp: async () => ({
          stdout: "first line",
          stderr: "read: showing lines 1-1 of 2 — use offset=2 to continue",
          exitCode: 0,
          stdoutTruncated: true,
        }),
      },
    );
    expect(r.stdout).toContain("first line");
    expect(r.stderr).toContain("use offset=2");
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderrTruncated).toBe(false);
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

  it("bounds parallel tool execution while preserving command order", async () => {
    let active = 0;
    let maxActive = 0;
    const r = await runNode(
      {
        id: "n",
        parallel: true,
        commands: Array.from({ length: 24 }, (_, index) => ({ tool: "slow", index })),
      },
      {
        cwd,
        executeToolOp: async (op) => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return { stdout: String(op.index), stderr: "", exitCode: 0 };
        },
      },
    );

    expect(maxActive).toBeLessThanOrEqual(8);
    expect(r.exitCode).toBe(0);
    const values = [...r.stdout.matchAll(/\[(\d+)\]\n(\d+)/g)].map((match) => match[2]);
    expect(values).toEqual(Array.from({ length: 24 }, (_, index) => String(index)));
  });

  it("returns immediately for an already-aborted signal", async () => {
    const r = await runNode({ id: "n", commands: ["echo nope"] }, { cwd, signal: AbortSignal.abort() });
    expect(r.stdout).not.toContain("nope");
  });

  it("marks truncation when a later chunk arrives after an exact OUTPUT_CAP prefix", async () => {
    const q = String.fromCharCode(39);
    const script = 'process.stdout.write("x".repeat(8192)); setTimeout(() => process.stdout.write("TAIL"), 30)';
    const r = await runNode({ id: "n", commands: [`node -e ${q}${script}${q}`] }, { cwd });
    expect(r.stdout).toContain("…[truncated");
    expect(r.stdout).not.toContain("TAIL");
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderrTruncated).toBe(false);
  });
});
