import { describe, expect, it } from "vitest";
import { findTaintedEvaluation } from "../../../core/shell/taint.ts";

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

describe("findTaintedEvaluation", () => {
  it.each(TAINTED)("tainted: %s", (command, name) => {
    expect(findTaintedEvaluation(command)).toBe(`arithmetic over data-derived variable ${name}`);
  });
  it.each(CLEAN)("clean: %s", (command) => {
    expect(findTaintedEvaluation(command)).toBeNull();
  });

  it("falls back to any arithmetic identifier when a context cannot be parsed", () => {
    // an unterminated `$[` hides where its expression ends
    expect(findTaintedEvaluation("read c; echo $[n")).toBe("arithmetic over data-derived variable n");
    // no data construct: nothing to fall back on
    expect(findTaintedEvaluation("echo $[n")).toBeNull();
  });

  it("stays linear on deeply nested arithmetic", () => {
    // A generous guard, not a benchmark: a quadratic scan of 40k nested
    // brackets takes far longer, while CI jitter stays well inside it.
    const deep = `c=$(cat f); echo ${"$((".repeat(20_000)}c${"))".repeat(20_000)}`;
    const started = performance.now();
    expect(findTaintedEvaluation(deep)).toBe("arithmetic over data-derived variable c");
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});

// R5: a data-derived value used as a variable NAME. Bash parses the name, and
// a subscript in it (`a[$(cmd)]`) runs cmd. Every row was verified to run the
// subscript on /bin/bash 3.2 and /bin/sh (macOS) with c='a[$(echo PWNED >&2)]'.
const TAINTED_NAMES: Array<[string, string]> = [
  ["c=$(cat f); echo ${!c}", "c"],
  ["c=$(cat f); echo \"${!c}\"", "c"],
  ["c=$(cat f); echo ${!c:-x}", "c"],
  ["c=$(cat f); echo ${!c#x}", "c"],
  ["c=$(cat f); [[ -v $c ]]", "c"],
  ["c=$(cat f); [[ -v \"$c\" ]]", "c"],
  ["c=$(cat f); printf -v \"$c\" x", "c"],
  ["c=$(cat f); printf -v \"${c}\" x", "c"],
  ["c=$(cat f); read \"$c\" <<< x", "c"],
  ["c=$(cat f); read -r \"$c\" <<< x", "c"],
  ["c=$(cat f); read -a \"$c\" <<< x", "c"],
  ["c=$(cat f); getopts a \"$c\" -a", "c"],
  ["c=$(cat f); declare \"$c=1\"", "c"],
  ["c=$(cat f); typeset \"$c=1\"", "c"],
  ["c=$(cat f); export \"$c=1\"", "c"],
  ["c=$(cat f); f(){ local \"$c=1\"; }; f", "c"],
  ["c=$(cat f); export \"$c\"", "c"],
  ["c=$(cat f); readonly \"$c\"", "c"],
  ["c=$(cat f); declare -p \"$c\"", "c"],
  ["c=$(cat f); unset -f \"$c\"", "c"],
  ["for c in *; do echo ${!c}; done", "c"],
  // R6: bash >= 4.3 semantics, unverifiable on bash 3.2 — flagged fail-closed.
  ["c=$(cat f); declare -n r=$c", "c"],
  ["c=$(cat f); f(){ local -n r=\"$c\"; }; f", "c"],
  ["c=$(cat f); typeset -n r=$c", "c"],
  ["c=$(cat f); declare -n \"$c\"", "c"],
  ["c=$(cat f); unset \"$c\"", "c"],
  ["c=$(cat f); unset -v \"$c\"", "c"],
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
  it.each(TAINTED_NAMES)("tainted: %s", (command, name) => {
    expect(findTaintedEvaluation(command)).toBe(`data-derived variable ${name} used as a variable name`);
  });
  it.each(CLEAN_NAMES)("clean: %s", (command) => {
    expect(findTaintedEvaluation(command)).toBeNull();
  });
});

// Fix round 1: shapes where data reached an evaluation context unseen.
const ROUND1_ARITHMETIC: Array<[string, string]> = [
  // C1: a substitution's output used directly as an arithmetic expression
  ["echo $(( $(cat f) ))", "command substitution output"],
  ["(( $(cat f) ))", "command substitution output"],
  ["echo $[ $(cat f) ]", "command substitution output"],
  ["arr[$(cat f)]=1", "command substitution output"],
  ["echo ${arr[$(cat f)]}", "command substitution output"],
  ["let \"$(cat f)\"", "command substitution output"],
  ["[[ $(cat f) -eq 1 ]]", "command substitution output"],
  ["echo $(( $(<f) ))", "command substitution output"],
  ["echo $(( `cat f` ))", "command substitution output"],
  ["(( `cat f` ))", "command substitution output"],
  ["echo $[ `cat f` ]", "command substitution output"],
  ["arr[`cat f`]=1", "command substitution output"],
  ["echo ${arr[`cat f`]}", "command substitution output"],
  ["let \"`cat f`\"", "command substitution output"],
  ["[[ `cat f` -eq 1 ]]", "command substitution output"],
  ["bash -c 'echo $(( $(cat f) ))'", "command substitution output"],
  ["bash -c '[[ $(cat f) -eq 1 ]]'", "command substitution output"],
  // C2: an assignment to an integer-declared variable evaluates its value
  ["declare -i n=$(cat f)", "data-derived variable n"],
  ["declare -i n; n=$(cat f)", "data-derived variable n"],
  ["declare -i n; read n < f", "data-derived variable n"],
  ["typeset -i n=$(cat f)", "data-derived variable n"],
  ["g() { local -i n=$(cat f); }; g", "data-derived variable n"],
  // C3: default-assignment expansions assign data
  [": ${c:=$(cat f)}; echo $((c))", "data-derived variable c"],
  [": ${c=$(cat f)}; ((c))", "data-derived variable c"],
  // C4: positional parameters set from data
  ["set -- \"$(cat f)\"; (( $1 ))", "data-derived variable $@"],
  ["set -- \"$(cat f)\"; c=$1; ((c))", "data-derived variable c"],
  ["set -- *; echo $(($1))", "data-derived variable $@"],
  ["g() { echo $(($1)); }; g \"$(cat f)\"", "data-derived variable $@"],
  ["sh -c 'echo $(($1))' _ \"$(cat f)\"", "data-derived variable $@"],
  // C5: filenames are data
  ["x=(*); echo $((x))", "data-derived variable x"],
  ["arr=(*); ((arr))", "data-derived variable arr"],
  ["x=($(cat f)); echo $((x))", "data-derived variable x"],
  ["for x in *; do ((x)); done", "data-derived variable x"],
];

const ROUND1_NAMES: Array<[string, string]> = [
  [": ${c:=$(cat f)}; echo ${!c}", "c"],
  ["set -- \"$(cat f)\"; echo ${!1}", "$@"],
  // M4: attached option forms
  ["c=$(cat f); printf -v\"$c\" x", "c"],
  ["c=$(cat f); read -a\"$c\" <<< x", "c"],
  // I1: bash 4+ builtins that take a variable name, fail closed
  ["c=$(cat f); mapfile -t \"$c\" < f", "c"],
  ["c=$(cat f); readarray -t \"$c\" < f", "c"],
  ["c=$(cat f); [[ -R $c ]]", "c"],
  ["c=$(cat f); wait -p \"$c\"", "c"],
];

const ROUND1_CLEAN = [
  "x=5; echo $((x+1))",
  "echo $((3*4))",
  "echo $((RANDOM % 10))",
  "n=$(wc -l < f); echo \"$n\"",
  "echo ${#arr[@]}",
  "c=$(cat f); echo \"$c\"",
  "echo ${!prefix*}",
  "declare -n r=literal",
  "(( a <(echo 1) ))",
  "x=(a b); echo $((x))",
  "set -- a b; echo $(($1))",
  "echo $(($1))",
  "declare -i n=5; n=6",
  ": ${c:=5}; echo $((c))",
  "mapfile -t lines < f",
];

describe("fix round 1: direct, integer, default, positional and glob sources", () => {
  it.each(ROUND1_ARITHMETIC)("tainted: %s", (command, name) => {
    expect(findTaintedEvaluation(command)).toBe(`arithmetic over ${name}`);
  });
  it.each(ROUND1_NAMES)("tainted name: %s", (command, name) => {
    expect(findTaintedEvaluation(command)).toBe(`data-derived variable ${name} used as a variable name`);
  });
  it.each(ROUND1_CLEAN)("clean: %s", (command) => {
    expect(findTaintedEvaluation(command)).toBeNull();
  });
});

// R12: a substitution's output used directly as a variable NAME operand.
const SUBSTITUTED_NAMES = [
  "printf -v \"$(cat f)\" x", "printf -v \"`cat f`\" x", "printf -v \"$(<f)\" x",
  "read \"$(cat f)\" <<< x", "read -a \"$(cat f)\" <<< x",
  "declare \"$(cat f)=1\"", "export \"$(cat f)=1\"", "readonly \"$(cat f)=1\"",
  "g() { local \"$(cat f)=1\"; }; g", "typeset \"$(cat f)=1\"",
  "unset \"$(cat f)\"", "getopts a \"$(cat f)\"", "mapfile -t \"$(cat f)\" < f",
  "declare -n r=\"$(cat f)\"", "[[ -v $(cat f) ]]", "[[ -v `cat f` ]]",
];
const SUBSTITUTED_VALUES = ["printf -v out '%s' \"$(cat f)\"", "read -r line < f", "declare \"x=$(cat f)\""];

describe("substitutions used directly as variable names (R12)", () => {
  it.each(SUBSTITUTED_NAMES)("tainted: %s", (command) => {
    expect(findTaintedEvaluation(command)).toBe("command substitution output used as a variable name");
  });
  it.each(SUBSTITUTED_VALUES)("clean: %s", (command) => {
    expect(findTaintedEvaluation(command)).toBeNull();
  });
});
