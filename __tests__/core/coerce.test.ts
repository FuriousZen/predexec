import { describe, expect, it } from "vitest";
import { coercePlan } from "../../core/coerce.ts";

describe("coercePlan — input is never mutated", () => {
  it("coercePlan does not mutate its input", () => {
    const p = { root: "a", nodes: '[{"id":"a","commands":["ls"]}]' };
    const c = structuredClone(p);
    coercePlan(p);
    expect(p).toEqual(c);
  });

  it("parses string conditions into a copy, leaving the caller's edges untouched", () => {
    const p = {
      root: "a",
      nodes: [
        { id: "a", commands: ["ls"], edges: [{ when: "exit == 0", to: "b" }] },
        { id: "b", commands: ["pwd"] },
      ],
    };
    const c = structuredClone(p);
    const coerced = coercePlan(p);
    expect(p).toEqual(c);
    expect(coerced.nodes[0]!.edges![0]!.when).toEqual({ kind: "exitCode", op: "eq", value: 0 });
  });

  it("fills a missing condition source on a copy only", () => {
    const p = {
      root: "a",
      nodes: [
        { id: "a", commands: ["ls"], edges: [{ when: { kind: "match", regex: "x" }, to: "b" }] },
        { id: "b", commands: ["pwd"] },
      ],
    };
    const c = structuredClone(p);
    const coerced = coercePlan(p);
    expect(p).toEqual(c);
    expect(coerced.nodes[0]!.edges![0]!.when).toMatchObject({ kind: "match", regex: "x", source: "stdout" });
  });
});
