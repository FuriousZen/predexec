import { describe, expect, it } from "vitest";
import { runPlanTree, validatePlan } from "./engine.ts";
import type { PlanNode, PlanTree } from "./types.ts";

const cwd = process.cwd();

describe("runPlanTree — traversal & stop reasons", () => {
  it("depth-0 leaf: runs one command, no fallback, terminal on success", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo hi"] }] };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("leaf");
    expect(r.fellBack).toBe(false);
    expect(r.terminal).toBe(true);
    expect(r.pathTaken).toEqual(["a"]);
    expect(r.depthReached).toBe(0);
  });

  it("a failing leaf is not terminal", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["exit 1"] }] };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("leaf");
    expect(r.terminal).toBe(false);
  });

  it("follows the first matching edge to a child", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [
        { id: "a", commands: ["exit 0"], edges: [{ when: { kind: "exitCode", op: "eq", value: 0 }, to: "ok" }] },
        { id: "ok", commands: ["echo matched"] },
      ],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.pathTaken).toEqual(["a", "ok"]);
    expect(r.depthReached).toBe(1);
    expect(r.edgesMatched).toBe(1);
    expect(r.transcript).toContain("matched");
  });

  it("first-match edge ordering: earlier edge wins even when both match", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [
        {
          id: "a",
          commands: ["exit 0"],
          edges: [
            { when: { kind: "always" }, to: "first" },
            { when: { kind: "exitCode", op: "eq", value: 0 }, to: "second" },
          ],
        },
        { id: "first", commands: ["echo first"] },
        { id: "second", commands: ["echo second"] },
      ],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.pathTaken).toEqual(["a", "first"]);
    expect(r.edgesEvaluated).toBe(1); // stops at the first match
  });

  it("noEdgeMatch: stops and falls back when no edge matches", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [
        { id: "a", commands: ["exit 0"], edges: [{ when: { kind: "exitCode", op: "eq", value: 99 }, to: "b" }] },
        { id: "b", commands: ["echo b"] },
      ],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("noEdgeMatch");
    expect(r.fellBack).toBe(true);
    expect(r.pathTaken).toEqual(["a"]);
    expect(r.edgesEvaluated).toBe(1);
    expect(r.edgesMatched).toBe(0);
  });

  it("maxDepth: stops at the cap", async () => {
    const plan: PlanTree = {
      root: "a",
      maxDepth: 0,
      nodes: [
        { id: "a", commands: ["exit 0"], edges: [{ when: { kind: "always" }, to: "b" }] },
        { id: "b", commands: ["echo b"] },
      ],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("maxDepth");
    expect(r.fellBack).toBe(true);
    expect(r.pathTaken).toEqual(["a"]);
  });

  it("mutationStop: hard-stops BEFORE running a declared mutating node", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [
        { id: "a", commands: ["exit 0"], edges: [{ when: { kind: "always" }, to: "w" }] },
        { id: "w", commands: ["echo SHOULD_NOT_RUN"], mutates: true },
      ],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("mutationStop");
    expect(r.fellBack).toBe(true);
    expect(r.pathTaken).toEqual(["a"]); // child never ran
    expect(r.transcript).not.toContain("node w (exit"); // no execution block for w
    expect(r.transcript).toContain("HARD-STOP");
  });

  it("mutationStop: undeclared destructive command is caught by the heuristic", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["rm -rf /tmp/whatever"] }] };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("mutationStop");
    expect(r.pathTaken).toEqual([]); // never ran
  });

  it("does NOT false-positive on 2>/dev/null or 2>&1", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: ["ls foo 2>/dev/null || echo missing", "cat bar 2>&1"] }],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).not.toBe("mutationStop");
    expect(r.pathTaken).toContain("a");
  });

  it("does NOT false-positive on JS arrow functions or >= comparisons in node -e", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [{
        id: "a",
        commands: [
          `node -e "const xs = [1,2,3]; xs.forEach(x => console.log(x))"`,
          `node -e "if (process.versions.node >= '18') console.log('ok')"`,
        ],
      }],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).not.toBe("mutationStop");
    expect(r.pathTaken).toContain("a");
  });

  it("does NOT false-positive on `>` comparisons inside single-quoted awk programs", async () => {
    // The exact case that tripped the hoopoff/mimo session: `awk '$1 > 200'`.
    const plan: PlanTree = {
      root: "a",
      nodes: [{
        id: "a",
        commands: ["find . -name '*.ts' -exec wc -l {} + | sort -rn | awk '$1 > 200 {print $2, $1}'"],
      }],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).not.toBe("mutationStop");
    expect(r.pathTaken).toEqual(["a"]);
  });

  it("does NOT false-positive on `>` inside [[ ]] tests or (( )) arithmetic", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [{
        id: "a",
        commands: ["x=5; [[ $x > 3 ]] && echo big", "(( 4 > 2 )) && echo yes"],
      }],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).not.toBe("mutationStop");
    expect(r.pathTaken).toEqual(["a"]);
  });

  it("mutationStop block names the offending command and token", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo ok", "echo hi > out.txt"] }] };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("mutationStop");
    expect(r.transcript).toContain("command 2"); // 1-based index of the offending command
    expect(r.transcript).toContain("echo hi > out.txt");
  });

  it("still catches real destructive commands (rm, file redirect)", async () => {
    const rmPlan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["rm -rf /tmp/whatever"] }] };
    expect((await runPlanTree(rmPlan, { cwd })).stoppedReason).toBe("mutationStop");

    const redirectPlan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo hi > output.txt"] }] };
    expect((await runPlanTree(redirectPlan, { cwd })).stoppedReason).toBe("mutationStop");

    const cpPlan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["cp -r src/ dest/"] }] };
    expect((await runPlanTree(cpPlan, { cwd })).stoppedReason).toBe("mutationStop");

    // Destructive word inside single quotes must still be caught (only angle
    // brackets are neutralized in quoted spans, not the whole span).
    const quotedRm: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["sh -c 'rm -rf /tmp/x'"] }] };
    expect((await runPlanTree(quotedRm, { cwd })).stoppedReason).toBe("mutationStop");
  });

  it("plan.cwd: runs commands and resolves fileExists in the given dir", async () => {
    // process.cwd() is .../predexec; "core" is a real subdir with this test file.
    const plan: PlanTree = {
      root: "a",
      cwd: "core",
      nodes: [
        {
          id: "a",
          commands: ["pwd"],
          edges: [{ when: { kind: "fileExists", path: "engine.test.ts" }, to: "found" }],
        },
        { id: "found", commands: ["echo IN_CORE"] },
      ],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.pathTaken).toEqual(["a", "found"]); // fileExists resolved relative to cwd/core
    expect(r.transcript).toContain("/core");
    expect(r.transcript).toContain("IN_CORE");
  });

  it("transcript: surfaces a cwd header and does NOT echo the raw command", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo body-output"] }] };
    const r = await runPlanTree(plan, { cwd });
    expect(r.transcript).toContain(`# cwd: ${cwd}`);
    expect(r.transcript).toContain("body-output"); // stdout still present
    expect(r.transcript).not.toContain("$ echo body-output"); // command not double-emitted
  });

  it("aborted: returns aborted when the signal is already set", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo hi"] }] };
    const r = await runPlanTree(plan, { cwd, signal: AbortSignal.abort() });
    expect(r.stoppedReason).toBe("aborted");
    expect(r.fellBack).toBe(true);
  });
});

describe("validatePlan", () => {
  const v = (plan: PlanTree) => validatePlan(plan, new Map<string, PlanNode>());

  it("accepts a well-formed plan", () => {
    expect(v({ root: "a", nodes: [{ id: "a", commands: ["echo hi"] }] })).toBeNull();
  });

  it("rejects an empty node list", () => {
    expect(v({ root: "a", nodes: [] })).toMatch(/no nodes/);
  });

  it("rejects a missing root", () => {
    expect(v({ root: "z", nodes: [{ id: "a", commands: [] }] })).toMatch(/root/);
  });

  it("rejects duplicate ids", () => {
    expect(v({ root: "a", nodes: [{ id: "a", commands: [] }, { id: "a", commands: [] }] })).toMatch(/duplicate/);
  });

  it("rejects an edge to a missing node", () => {
    expect(
      v({ root: "a", nodes: [{ id: "a", commands: [], edges: [{ when: { kind: "always" }, to: "ghost" }] }] }),
    ).toMatch(/missing node/);
  });

  it("tier rule: a low-confidence (match) edge may not gate a mutating node", () => {
    const err = v({
      root: "a",
      nodes: [
        { id: "a", commands: [], edges: [{ when: { kind: "match", source: "stdout", regex: "ok" }, to: "w" }] },
        { id: "w", commands: ["echo x"], mutates: true },
      ],
    });
    expect(err).toMatch(/low-confidence/);
  });

  it("tier rule: a high-confidence edge MAY gate a mutating node", () => {
    expect(
      v({
        root: "a",
        nodes: [
          { id: "a", commands: [], edges: [{ when: { kind: "exitCode", op: "eq", value: 0 }, to: "w" }] },
          { id: "w", commands: ["echo x"], mutates: true },
        ],
      }),
    ).toBeNull();
  });

  it("runPlanTree returns stoppedReason 'error' on an invalid plan", async () => {
    const r = await runPlanTree({ root: "z", nodes: [{ id: "a", commands: [] }] }, { cwd });
    expect(r.stoppedReason).toBe("error");
    expect(r.transcript).toContain("validation failed");
  });
});
