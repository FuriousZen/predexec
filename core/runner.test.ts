import { describe, expect, it } from "vitest";
import { runNode } from "./runner.ts";

const cwd = process.cwd();

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
