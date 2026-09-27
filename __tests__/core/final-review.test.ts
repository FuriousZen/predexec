import { describe, expect, it } from "vitest";
import { findDestructiveToken, isDestructiveCommand } from "../../core/destructive.ts";

/**
 * Final whole-branch review fix wave (rulings R60–R66). Unit-level classifier
 * assertions only: nothing here is ever executed. Payload words are harmless
 * placeholders (`id`, `./x.js`, throwaway names).
 */

// C1 / R60: node-based D1 tools are node programs, so an interpreter preload
// variable loads a repository file into them. Every INTERPRETER_PRELOAD_ENV
// name is dangerous for any head, and any environment write strips the D1
// reader verdict the way R43b strips multi-tools.
describe("C1 — preload env on D1-governed node tools (R60)", () => {
  it.each([
    "NODE_OPTIONS=--require=./x.js npm ls",
    "NODE_OPTIONS='-r ./x.js' pnpm list",
    "env NODE_OPTIONS=-r./x.js npm view left-pad",
    "NODE_OPTIONS=--import=./x.mjs jest --version",
    "NODE_OPTIONS=-r./x.js vitest --version",
    "NODE_OPTIONS=-r./x.js tsx --version",
    "BUN_OPTIONS=--preload=./x.js cat f",
    "PERL5OPT=-Mx ls",
    "RUBYOPT=-rx ls",
    "PYTHONPATH=x ls",
    "PHPRC=x ls",
    "DENO_OPTIONS=x ls",
    "env PERL5LIB=x git log",
    // R43b strip for D1 heads: any assignment anywhere in the command
    "FOO=1 npm ls",
    "x=1; npm ls",
    "export FOO=1; pnpm why left-pad",
    "FOO=1 jest --version",
    "FOO=1 cargo version",
    "FOO=1 make --version",
  ])("%j is mutating", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each([
    "npm ls", "pnpm list", "npm view left-pad", "jest --version", "vitest --version", "tsx --version",
    "cargo version", "make --version", "go version",
  ])("%j stays read-only", (c) => expect(findDestructiveToken(c)).toBeNull());
});

// C2 / R60: under xtrace bash expands PS4 (command substitution included)
// before each traced command; SHELLOPTS/BASHOPTS turn xtrace on in a child.
describe("C2 — PS4, SHELLOPTS and BASHOPTS are command-bearing (R60)", () => {
  it.each([
    "PS4='$(id)'; set -x; ls",
    "PS4='`id`' bash -xc ls",
    "export PS4='$(id)'; set -x; ls",
    "declare PS4='$(id)'; set -x; ls",
    "read PS4 < f; set -x; ls",
    "printf -v PS4 %s x; set -x; ls",
    "SHELLOPTS=xtrace ls",
    "export SHELLOPTS; ls",
    "BASHOPTS=x ls",
    "env SHELLOPTS=xtrace ls",
  ])("%j is mutating", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(["set -x; ls", "echo $PS4", "set -o pipefail; ls"])("%j stays read-only", (c) =>
    expect(findDestructiveToken(c)).toBeNull());
});

// C3 / R60: on macOS `more` is less, so it shares less's environment and
// argv checks (input preprocessor, lesskey sources, $LESS, log files).
describe("C3 — more shares less's checks (R60)", () => {
  it.each([
    "LESSOPEN='|id %s' more f",
    "LESSCLOSE=x more f",
    "env LESSOPEN=x more f",
    "LESSKEY_CONTENT=x more f",
    "LESS=-ofile more f",
    "more -k keys f",
    "more --lesskey-src=keys f",
    "more --lesskey-file=keys f",
    "more -o log f",
    "more --log-file=log f",
    "more '+!id' f",
  ])("%j is mutating", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(["more f", "more -N f", "more +10 f", "more +/pattern f", "cat f | more"])("%j stays read-only", (c) =>
    expect(findDestructiveToken(c)).toBeNull());
});

// C4 / R60: `git grep -O[cmd]` opens matching files in a pager (the value,
// or the configured pager), clustered or attached, like the long form.
describe("C4 — git grep short -O stops (R60)", () => {
  it.each([
    "git grep -O foo",
    "git grep -Oid foo",
    "git grep -iO foo",
    "git grep -nOid foo",
    "git -C . grep -O foo",
    "git grep --open-files-in-pager foo",
  ])("%j is mutating", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(["git grep -n foo", "git grep -in foo", "git grep -e O foo", "git log -n 5"])(
    "%j stays read-only", (c) => expect(findDestructiveToken(c)).toBeNull());
});

// M1 / R66: `--exec-path=<dir>` moves where git finds its sub-programs; a
// verb after it is refused. The bare query forms stay read-only.
describe("M1 — git --exec-path=<dir> before a verb (R66)", () => {
  it.each(["git --exec-path=/x log", "git --exec-path=. status", "git -C . --exec-path=/x diff"])(
    "%j is mutating", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(["git --exec-path", "git --exec-path=/usr/libexec/git-core", "git log"])("%j stays read-only", (c) =>
    expect(findDestructiveToken(c)).toBeNull());
});
