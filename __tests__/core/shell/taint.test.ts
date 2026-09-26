import { describe, expect, it } from "vitest";
import { findTaintedArithmetic } from "../../../core/shell/taint.ts";

// E-A: in an arithmetic context bash evaluates a variable's VALUE as an
// expression, so `c='a[$(cmd)]'; echo $((c))` runs cmd. A value that comes
// from data inside the same command is attacker-controlled.
const TAINTED: Array<[string, string]> = [
  ["c=$(cat f); echo $((c))", "c"],
  ["c=`cat f`; (( c ))", "c"],
  ["read c < f; let c", "c"],
  ["read -r c <<< \"$x\"; echo $((c+1))", "c"],
  ["mapfile -t a < f; echo ${a[0]}; echo $((a))", "a"],
  ["printf -v c '%s' \"$(cat f)\"; echo ${s:c:1}", "c"],
  ["for c in $(cat f); do echo $((c)); done", "c"],
  ["c=$(cat f); d=$c; echo $((d))", "d"],
  ["c=$(cat f); [[ c -eq 1 ]]", "c"],
  ["c=$(cat f); declare -i n=c", "c"],
  ["c=$(cat f); echo ${arr[c]}", "c"],
  ["c=$(cat f); echo $(( $c ))", "c"],
  ["c=$(cat f); echo \"$(( c * 2 ))\"", "c"],
  // bash re-evaluates a name's value, so a bare-name copy carries the taint
  ["c=$(cat f); d=c; echo $((d))", "d"],
  // further sources
  ["readarray a < f; echo $((a))", "a"],
  ["printf -vc '%s' x; echo $((c))", "c"],
  ["for c in *; do echo $((c)); done", "c"],
  ["for c; do echo $((c)); done", "c"],
  ["select c in $(ls); do echo $((c)); done", "c"],
  ["while getopts ab: o; do echo $((OPTARG)); done", "OPTARG"],
  ["read; echo $((REPLY))", "REPLY"],
  ["IFS=, read -ra arr < f; echo $((arr))", "arr"],
  ["c=( $(cat f) ); echo $((c))", "c"],
  ["export c=$(cat f); echo $((c))", "c"],
  // further arithmetic contexts
  ["c=$(cat f); declare -i n; n=c", "c"],
  ["c=$(cat f); for ((i=0; i<c; i++)); do echo; done", "c"],
  ["c=$(cat f); echo $[c]", "c"],
  ["c=$(cat f); arr[c]=1", "c"],
  ["c=$(cat f); [[ 1 -lt $c ]]", "c"],
  ["c=$(cat f); echo ${s: c}", "c"],
  ["c=$(cat f); let 'n = c + 1'", "c"],
  // nested bodies
  ["x=$(read c; echo $((c)))", "c"],
  ["{ read c; }; echo $((c))", "c"],
  ["if read -r z; then let z; fi", "z"],
];

const CLEAN = [
  "x=5; echo $((x+1))",
  "echo $((3*4))",
  "echo $((RANDOM % 10))",
  "n=$(wc -l < f); echo \"$n\"",
  "echo ${#arr[@]}",
  "for c in 1 2 3; do echo $((c)); done",
  "c=$(cat f); echo \"$c\"",
  "c=$(cat f); echo ${c:0:3}",
  "c=$(cat f); echo ${c:-default}",
  "c=$(cat f); [[ $c == x ]]",
  "c=$(cat f); echo $((16#ff + 0x1f))",
  "c='$(cat f)'; echo $((d))",
  "read c < f; echo \"$c\"",
  "echo ${a[0]}",
  "",
];

describe("findTaintedArithmetic", () => {
  it.each(TAINTED)("tainted: %s", (command, name) => {
    expect(findTaintedArithmetic(command)).toBe(`arithmetic over data-derived variable ${name}`);
  });
  it.each(CLEAN)("clean: %s", (command) => {
    expect(findTaintedArithmetic(command)).toBeNull();
  });

  it("falls back to any arithmetic identifier when a context cannot be parsed", () => {
    // an unterminated `$[` hides where its expression ends
    expect(findTaintedArithmetic("read c; echo $[n")).toBe("arithmetic over data-derived variable n");
    // no data construct: nothing to fall back on
    expect(findTaintedArithmetic("echo $[n")).toBeNull();
  });

  it("stays linear on deeply nested arithmetic", () => {
    const deep = `c=$(cat f); echo ${"$((".repeat(20_000)}c${"))".repeat(20_000)}`;
    const started = performance.now();
    expect(findTaintedArithmetic(deep)).toBe("arithmetic over data-derived variable c");
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

// R5: a data-derived value used as a variable NAME. Bash parses the name, and
// a subscript in it (`a[$(cmd)]`) runs cmd. Every row was verified to run the
// subscript on /bin/bash 3.2 and /bin/sh (macOS) with c='a[$(echo PWNED >&2)]'.
const TAINTED_NAMES = [
  "c=$(cat f); echo ${!c}", "c=$(cat f); echo \"${!c}\"", "c=$(cat f); echo ${!c:-x}", "c=$(cat f); echo ${!c#x}",
  "c=$(cat f); [[ -v $c ]]", "c=$(cat f); [[ -v \"$c\" ]]",
  "c=$(cat f); printf -v \"$c\" x", "c=$(cat f); printf -v \"${c}\" x",
  "c=$(cat f); read \"$c\" <<< x", "c=$(cat f); read -r \"$c\" <<< x", "c=$(cat f); read -a \"$c\" <<< x",
  "c=$(cat f); getopts a \"$c\" -a",
  "c=$(cat f); declare \"$c=1\"", "c=$(cat f); typeset \"$c=1\"", "c=$(cat f); export \"$c=1\"",
  "c=$(cat f); f(){ local \"$c=1\"; }; f", "c=$(cat f); export \"$c\"", "c=$(cat f); readonly \"$c\"",
  "c=$(cat f); declare -p \"$c\"", "c=$(cat f); unset -f \"$c\"",
  "for c in *; do echo ${!c}; done",
  // R6: bash >= 4.3 semantics, unverifiable on bash 3.2 — flagged fail-closed.
  "c=$(cat f); declare -n r=$c", "c=$(cat f); f(){ local -n r=\"$c\"; }; f", "c=$(cat f); typeset -n r=$c",
  "c=$(cat f); declare -n \"$c\"", "c=$(cat f); unset \"$c\"", "c=$(cat f); unset -v \"$c\"",
];

// Measured NOT to evaluate on bash 3.2 / sh (`test -v` is unsupported there),
// or no data-derived name is involved.
const CLEAN_NAMES = [
  "c=$(cat f); echo \"$c\"", "echo ${!prefix*}", "echo ${!prefix@}", "declare -n r=literal",
  "c=$(cat f); echo ${!c[@]}", "c=$(cat f); declare \"$c\"", "c=$(cat f); f(){ local \"$c\"; }; f",
  "c=$(cat f); test -v \"$c\"", "c=$(cat f); read -p \"$c\" x",
  "c=lit; echo ${!c}", "c=lit; printf -v \"$c\" x",
];

describe("data-derived values used as variable names", () => {
  it.each(TAINTED_NAMES)("tainted: %s", (command) => {
    expect(findTaintedArithmetic(command)).toMatch(/^data-derived variable (c|OPTARG) used as a variable name$/);
  });
  it.each(CLEAN_NAMES)("clean: %s", (command) => {
    expect(findTaintedArithmetic(command)).toBeNull();
  });
});
