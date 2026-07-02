import { describe, expect, it } from "vitest";
import {
  STEERING_LINE,
  STEERING_MARKER,
  systemHasRoutingInstructions,
} from "../steering.ts";

describe("steering — systemHasRoutingInstructions guard", () => {
  it("returns false for an empty system prompt (opencode should inject)", () => {
    expect(systemHasRoutingInstructions([])).toBe(false);
  });

  it("returns false when no entry mentions predexec", () => {
    expect(systemHasRoutingInstructions(["You are a helpful agent.", "Use bash for reads."])).toBe(false);
  });

  it("returns true when a host doc already carries the routing rule (skip injection)", () => {
    const system = ["You are a helpful agent.", "Use predexec for all read-only shell operations."];
    expect(systemHasRoutingInstructions(system)).toBe(true);
  });

  it("detects STEERING_LINE itself (idempotent — no double injection)", () => {
    expect(systemHasRoutingInstructions([STEERING_LINE])).toBe(true);
  });

  it("STEERING_LINE contains the marker so a prior injection is recognized", () => {
    expect(STEERING_LINE).toContain(STEERING_MARKER);
  });

  it("tolerates non-string entries without throwing", () => {
    expect(systemHasRoutingInstructions([null as any, 42 as any, "predexec routing"])).toBe(true);
    expect(systemHasRoutingInstructions([null as any, 42 as any])).toBe(false);
  });
});
