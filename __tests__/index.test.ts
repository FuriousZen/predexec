import { describe, expect, it } from "vitest";
import { coercePlan } from "../.pi/extension/index.ts";

describe("coercePlan — defensive param recovery", () => {
  const good = { root: "a", nodes: [{ id: "a", commands: ["echo hi"] }] };

  it("passes a well-formed object through unchanged", () => {
    expect(coercePlan(good)).toEqual(good);
  });

  it("parses a fully stringified plan", () => {
    expect(coercePlan(JSON.stringify(good))).toEqual(good);
  });

  it("parses a stringified `nodes` array (the mimo double-encode case)", () => {
    const plan = coercePlan({ root: "a", nodes: JSON.stringify(good.nodes) });
    expect(plan.nodes).toEqual(good.nodes);
    expect(plan.root).toBe("a");
  });

  it("throws a readable error on malformed JSON", () => {
    expect(() => coercePlan("{not json")).toThrow(/could not parse `plan`/);
  });

  it("throws a shape error (not a validator dump) when root/nodes are missing", () => {
    expect(() => coercePlan({ foo: 1 })).toThrow(/`root`.*`nodes`/);
  });

  it("coerces string edge conditions into objects", () => {
    const plan = coercePlan({
      root: "a",
      nodes: [{
        id: "a",
        commands: ["echo hi"],
        edges: [{ when: "exit == 0", to: "b" }],
      }, {
        id: "b",
        commands: ["echo done"],
      }],
    });
    expect(plan.nodes[0]!.edges![0]!.when).toEqual({ kind: "exitCode", op: "eq", value: 0 });
  });

  it("throws a readable error on unparseable condition string", () => {
    expect(() => coercePlan({
      root: "a",
      nodes: [{ id: "a", commands: ["echo"], edges: [{ when: "gibberish", to: "b" }] }],
    })).toThrow(/could not parse condition string "gibberish"/);
  });

  it("leaves object conditions untouched", () => {
    const cond = { kind: "exitCode", op: "eq", value: 0 };
    const plan = coercePlan({
      root: "a",
      nodes: [{ id: "a", commands: ["echo"], edges: [{ when: cond, to: "b" }] }, { id: "b", commands: ["echo"] }],
    });
    expect(plan.nodes[0]!.edges![0]!.when).toEqual(cond);
  });
});
