import { describe, expect, it } from "vitest";
import { coercePlan } from "./index.ts";

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
    expect(() => coercePlan({ foo: 1 })).toThrow(/string `root` and an array `nodes`/);
  });
});
