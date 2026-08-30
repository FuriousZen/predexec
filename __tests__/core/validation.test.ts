import { describe, expect, it } from "vitest";
import { validateOperation } from "../../core/validation.ts";
import {
  MAX_FIND_RESULTS,
  MAX_GREP_CONTEXT,
  MAX_GREP_RESULTS,
  MAX_LS_ENTRIES,
  MAX_READ_LINES,
  MAX_GREP_PATTERN_LENGTH,
} from "../../core/types.ts";

describe("validateOperation — bounded native operation arguments", () => {
  it.each([
    ["read limit", { tool: "read", path: "file.txt", limit: MAX_READ_LINES }, MAX_READ_LINES + 1],
    ["grep limit", { tool: "grep", pattern: "x", limit: MAX_GREP_RESULTS }, MAX_GREP_RESULTS + 1],
    ["find limit", { tool: "find", pattern: "*.ts", limit: MAX_FIND_RESULTS }, MAX_FIND_RESULTS + 1],
    ["ls limit", { tool: "ls", limit: MAX_LS_ENTRIES }, MAX_LS_ENTRIES + 1],
    ["grep context", { tool: "grep", pattern: "x", context: MAX_GREP_CONTEXT }, MAX_GREP_CONTEXT + 1],
  ])("accepts the exact %s ceiling and rejects one above it", (_label, operation, over) => {
    expect(validateOperation(operation)).toBeNull();
    const key = _label === "grep context" ? "context" : "limit";
    expect(validateOperation({ ...operation, [key]: over })).toMatch(/maximum|at most|must be/);
  });

  it.each([
    ["read limit", { tool: "read", path: "file.txt", limit: 0 }],
    ["grep limit", { tool: "grep", pattern: "x", limit: -1 }],
    ["find limit", { tool: "find", pattern: "*.ts", limit: 1.5 }],
    ["ls limit", { tool: "ls", limit: Number.POSITIVE_INFINITY }],
    ["grep context", { tool: "grep", pattern: "x", context: -1 }],
    ["read offset", { tool: "read", path: "file.txt", offset: 0 }],
    ["read fractional offset", { tool: "read", path: "file.txt", offset: 1.5 }],
  ])("rejects non-positive or non-integral %s values", (_label, operation) => {
    expect(String(validateOperation(operation))).toMatch(/positive integer|non-negative integer|integer|finite number/);
  });

  it("accepts an omitted limit, a one-based offset, and zero grep context", () => {
    expect(validateOperation({ tool: "read", path: "file.txt" })).toBeNull();
    expect(validateOperation({ tool: "read", path: "file.txt", offset: 1 })).toBeNull();
    expect(validateOperation({ tool: "grep", pattern: "x", context: 0 })).toBeNull();
  });

  it("accepts a grep pattern at the shared ceiling and rejects one character over", () => {
    const exact = { tool: "grep", pattern: "x".repeat(MAX_GREP_PATTERN_LENGTH) };
    expect(validateOperation(exact)).toBeNull();
    expect(validateOperation({ ...exact, pattern: `${exact.pattern}x` })).toMatch(/maximum|at most/);
  });
});
