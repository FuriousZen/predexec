import { describe, expect, it } from "vitest";
import {
  commandsWithUnresolvableOperands,
  operandHeadMayReadPaths,
  ruleHeadCouldMatch,
} from "../../../core/index.ts";

const heads = (command: string) =>
  commandsWithUnresolvableOperands(command).map(({ head, reason }) => ({ head, reason }));

describe("commandsWithUnresolvableOperands", () => {
  it.each<[string, string, string]>([
    ["echo .env | xargs cat", "cat", "xargs"],
    ["find . | xargs -0 grep x", "grep", "xargs"],
    ["while read f; do cat \"$f\"; done < list", "cat", "read-loop"],
    ["cat list | while IFS= read -r line; do head -n1 \"$line\"; done", "head", "read-loop"],
    ["cat $(cat names.txt)", "cat", "substitution-operand"],
    ["cat `cat names.txt`", "cat", "substitution-operand"],
    ["cat \"$f\"", "cat", "variable-operand"],
    ["cat \"${f}\"", "cat", "variable-operand"],
    ["cat < \"$f\"", "cat", "variable-operand"],
  ])("%s ⇒ %s via %s", (command, head, reason) => {
    expect(heads(command)).toContainEqual({ head, reason });
  });

  it("names the clause the operand came from", () => {
    expect(commandsWithUnresolvableOperands("ls && echo .env | xargs cat")).toEqual([
      { head: "cat", clause: "xargs cat", reason: "xargs" },
    ]);
  });

  it.each([
    "cat .env",
    "echo hi",
    "grep -rn foo src",
    "for f in a b; do echo x; done",
    "cat <<EOF\n$HOME\nEOF",
    "cat <<< \"$HOME\"",
    "FOO=$HOME ls",
  ])("reports nothing for literal operands: %s", (command) => {
    expect(commandsWithUnresolvableOperands(command)).toEqual([]);
  });

  it("resolves the command xargs runs through its options and wrappers", () => {
    expect(heads("xargs -I{} cat {}")).toEqual([{ head: "cat", reason: "xargs" }]);
    expect(heads("xargs -0rn1 -P 4 timeout 5 cat")).toEqual([{ head: "cat", reason: "xargs" }]);
    expect(heads("xargs -d '\\n' --max-args=2 /bin/cat")).toEqual([{ head: "cat", reason: "xargs" }]);
    expect(heads("xargs -J % cp % dest")).toEqual([{ head: "cp", reason: "xargs" }]);
    expect(heads("xargs")).toEqual([{ head: "echo", reason: "xargs" }]);
    expect(heads("env -S 'xargs cat'")).toEqual([{ head: "cat", reason: "xargs" }]);
  });

  it("an unknown xargs option makes every later non-option word a candidate command", () => {
    const found = heads("xargs --frobnicate x cat");
    expect(found).toContainEqual({ head: "cat", reason: "xargs" });
    expect(found).toContainEqual({ head: "x", reason: "xargs" });
  });

  it("finds operands inside substitution and control-structure bodies", () => {
    expect(heads("echo $(cat \"$f\")")).toContainEqual({ head: "cat", reason: "variable-operand" });
    expect(heads("if true; then ls | xargs cat; fi")).toContainEqual({ head: "cat", reason: "xargs" });
  });
});

describe("ruleHeadCouldMatch", () => {
  it("matches the rule's first word, its wrapper-stripped head, and wildcards", () => {
    expect(ruleHeadCouldMatch(["cat", ".env"], "cat")).toBe(true);
    expect(ruleHeadCouldMatch(["timeout", "5", "cat", ".env"], "cat")).toBe(true);
    expect(ruleHeadCouldMatch(["/bin/cat", ".env"], "cat")).toBe(true);
    expect(ruleHeadCouldMatch(["*"], "cat")).toBe(true);
    expect(ruleHeadCouldMatch([], "cat")).toBe(true);
    expect(ruleHeadCouldMatch(["c?t*"], "cat")).toBe(true);
    expect(ruleHeadCouldMatch(["git", "push"], "cat")).toBe(false);
    expect(ruleHeadCouldMatch(["ca"], "cat")).toBe(false);
  });

  it("treats `*` literally when the host has no globs", () => {
    expect(ruleHeadCouldMatch(["c*"], "cat", { glob: false })).toBe(false);
    expect(ruleHeadCouldMatch(["cat"], "cat", { glob: false })).toBe(true);
  });
});

describe("operandHeadMayReadPaths", () => {
  it("is false only for commands whose operands are never file paths", () => {
    expect(operandHeadMayReadPaths("cat")).toBe(true);
    expect(operandHeadMayReadPaths("python3")).toBe(true);
    expect(operandHeadMayReadPaths("echo")).toBe(false);
    expect(operandHeadMayReadPaths("printf")).toBe(false);
  });
});
