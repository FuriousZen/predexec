import { describe, expect, it } from "vitest";
import {
  ANY_HEAD,
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

describe("fix round 1: shell payloads, find -exec and parallel feed data too", () => {
  it.each<[string, string, string]>([
    ["cat list | xargs -I{} sh -c 'cat {}'", "cat", "xargs"],
    ["cat list | xargs -I{} bash -c 'head -c 99 {}'", "head", "xargs"],
    ["xargs sh -c 'cat \"$1\"' _", "cat", "xargs"],
    ["find . -name '.e*' -exec cat {} +", "cat", "find-exec"],
    ["find . -name '.e*' -exec cat {} \;", "cat", "find-exec"],
    ["find . -execdir timeout 5 cat {} ';'", "cat", "find-exec"],
    ["find . -ok cat {} \;", "cat", "find-exec"],
    ["find . -exec sh -c 'cat \"$1\"' _ {} \;", "cat", "find-exec"],
    ["cat list | parallel cat", "cat", "parallel"],
    ["parallel cat :::: list", "cat", "parallel"],
    ["parallel cat ::: $(cat list)", "cat", "parallel"],
    ["parallel -j4 cat ::: a", "cat", "parallel"],
    ["parallel -j 4 --xargs cat", "cat", "parallel"],
    ["xargs parallel cat", "cat", "parallel"],
  ])("%s ⇒ %s via %s", (command, head, reason) => {
    expect(heads(command)).toContainEqual({ head, reason });
  });

  it.each([
    "parallel --frobnicate cat",
    "parallel ::: 'cat .env'",
    "cat cmds | parallel",
  ])("parallel it cannot parse confidently is unresolvable for any rule: %s", (command) => {
    expect(heads(command)).toContainEqual({ head: ANY_HEAD, reason: "parallel" });
  });

  it("the for-loop header names no command, and one head/reason is reported once", () => {
    expect(heads("for f in $(cat list); do cat \"$f\"; done")).toEqual([{ head: "cat", reason: "variable-operand" }]);
    expect(heads("while read f; do head \"$f\"; done < l")).toEqual([{ head: "head", reason: "read-loop" }]);
  });

  it("find without an exec action feeds nothing", () => {
    expect(heads("find . -name '*.ts' -print")).toEqual([]);
  });
});

describe("ruleHeadCouldMatch — unknown words, the any-head, and bounded globbing", () => {
  it("an unknown (null) word in the head position could match anything", () => {
    expect(ruleHeadCouldMatch([null, "x"], "cat")).toBe(true);
    expect(ruleHeadCouldMatch(["timeout", "5", null], "cat")).toBe(true);
    expect(ruleHeadCouldMatch(["git", null], "cat")).toBe(false);
  });

  it("the any-head matches every rule", () => {
    expect(ruleHeadCouldMatch(["git", "push"], ANY_HEAD)).toBe(true);
    expect(ruleHeadCouldMatch(["git"], ANY_HEAD, { glob: false })).toBe(true);
  });

  it("a pathological glob against a long head stays fast", () => {
    const started = Date.now();
    expect(ruleHeadCouldMatch([`${"*a".repeat(30)}*b`], "a".repeat(100_000))).toBe(true);
    expect(ruleHeadCouldMatch([`${"*a".repeat(30)}*b`], "a".repeat(200))).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
