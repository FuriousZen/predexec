import { describe, expect, it } from "vitest";
import {
  CONDITION_KINDS,
  MAX_CONDITION_LENGTH,
  MAX_CONDITION_TOTAL_LENGTH,
  MAX_GREP_PATTERN_LENGTH,
  MAX_OPERATIONS_PER_NODE,
  MAX_PARALLEL_CONCURRENCY,
  PLAN_FIELD_NAMES,
  PLAN_SHAPE_DESCRIPTION,
  RESOURCE_LIMIT_DESCRIPTION,
  TOOL_OPERATION_NAMES,
} from "../plan-language.ts";

describe("canonical plan language", () => {
  it("publishes canonical plan field names for schema projections", () => {
    expect(PLAN_FIELD_NAMES).toMatchObject({
      root: "root",
      nodes: "nodes",
      commands: "commands",
      cwd: "cwd",
      maxDepth: "maxDepth",
    });
    expect(Object.isFrozen(PLAN_FIELD_NAMES)).toBe(true);
  });

  it("publishes immutable condition and tool vocabularies", () => {
    expect(CONDITION_KINDS).toEqual(["exitCode", "fileExists", "jsonPath", "numeric", "match", "always"]);
    expect(TOOL_OPERATION_NAMES).toEqual(["read", "grep", "find", "ls"]);
    expect(Object.isFrozen(CONDITION_KINDS)).toBe(true);
    expect(Object.isFrozen(TOOL_OPERATION_NAMES)).toBe(true);
  });

  it("teaches the complete bounded plan shape", () => {
    for (const condition of CONDITION_KINDS) expect(PLAN_SHAPE_DESCRIPTION).toContain(condition);
    for (const tool of TOOL_OPERATION_NAMES) expect(PLAN_SHAPE_DESCRIPTION).toContain(`tool:"${tool}"`);
    expect(PLAN_SHAPE_DESCRIPTION).toContain(String(MAX_OPERATIONS_PER_NODE));
    expect(PLAN_SHAPE_DESCRIPTION).toContain(String(MAX_PARALLEL_CONCURRENCY));
    expect(PLAN_SHAPE_DESCRIPTION).toContain("relative");
    expect(PLAN_SHAPE_DESCRIPTION).toContain("one-operation");
    expect(PLAN_SHAPE_DESCRIPTION).toContain("mutates");
    expect(PLAN_SHAPE_DESCRIPTION).toContain(`${MAX_CONDITION_LENGTH} characters per field`);
    expect(PLAN_SHAPE_DESCRIPTION).toContain(`${MAX_CONDITION_TOTAL_LENGTH} characters in aggregate`);
    expect(PLAN_SHAPE_DESCRIPTION).toContain(`grep patterns are capped at ${MAX_GREP_PATTERN_LENGTH} characters`);
    expect(PLAN_SHAPE_DESCRIPTION).toContain(RESOURCE_LIMIT_DESCRIPTION);
    expect(RESOURCE_LIMIT_DESCRIPTION).toContain("read limit at most 10000");
    expect(RESOURCE_LIMIT_DESCRIPTION).toContain("grep/find limit at most 1000");
    expect(RESOURCE_LIMIT_DESCRIPTION).toContain("ls limit at most 5000");
    expect(RESOURCE_LIMIT_DESCRIPTION).toContain("grep context at most 100");
  });
});
