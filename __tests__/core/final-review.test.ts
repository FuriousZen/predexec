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

// I2 / M2 / R62: a one-word allowScripts path entry names the script an
// interpreter runs. A value-taking option before the operand (bare `-I dir`,
// `-r lib`, `--check-hash-based-pycs mode`, node `-r mod`) could make the
// entry match the option's value while a different file runs, so any
// value-taking or unknown option before the operand means no script is named
// (fail closed); an exact argv-prefix entry still matches.
describe("I2 — allowScripts one-word entries and value-taking options (R62)", () => {
  const byPath = { allowScripts: ["scripts/r.py", "scripts/r.pl", "scripts/r.rb", "scripts/r.js", "scripts/r.php", "scripts/r.ts"] };
  it.each([
    "perl -I scripts/r.pl other.pl",
    "perl -wI scripts/r.pl other.pl",
    "perl -Mstrict scripts/r.pl",
    "perl -Ilib scripts/r.pl",
    "ruby -I scripts/r.rb other.rb",
    "ruby -C scripts/r.rb other.rb",
    "ruby -r scripts/r.rb other.rb",
    "ruby -wr scripts/r.rb other.rb",
    "ruby --encoding scripts/r.rb other.rb",
    "python3 --check-hash-based-pycs scripts/r.py other.py",
    "python3 -W scripts/r.py other.py",
    "python3 -X scripts/r.py other.py",
    "python3 --unknown scripts/r.py",
    "node -r scripts/r.js other.js",
    "node --require scripts/r.js other.js",
    "node --import scripts/r.js other.js",
    "node --require=./x.js scripts/r.js",
    "bun --preload scripts/r.js other.js",
    "php -c scripts/r.php other.php",
    "php -d x=1 scripts/r.php",
    "deno run --config scripts/r.ts other.ts",
  ])("no one-word match: %j", (c) => expect(isDestructiveCommand(c, byPath)).toBe(true));
  it.each([
    "perl scripts/r.pl",
    "perl -w scripts/r.pl",
    "ruby -w scripts/r.rb",
    "ruby --verbose scripts/r.rb",
    "python3 scripts/r.py",
    "python3 -u scripts/r.py",
    "python3 -bB scripts/r.py",
    "node scripts/r.js",
    "node --no-warnings scripts/r.js",
    "bun scripts/r.js",
    "bun run scripts/r.js",
    "php scripts/r.php",
  ])("one-word match: %j", (c) => expect(findDestructiveToken(c, byPath)).toBeNull());
  it("an exact argv-prefix entry still matches with value-taking options", () => {
    expect(findDestructiveToken("perl -I lib scripts/r.pl", { allowScripts: ["perl -I lib scripts/r.pl"] })).toBeNull();
    expect(findDestructiveToken("python3 -W ignore scripts/r.py", { allowScripts: ["python3 -W ignore scripts/r.py"] })).toBeNull();
  });
  it("python -m module detection survives a leading value option", () => {
    expect(findDestructiveToken("python3 -W ignore -m json.tool f.json")).toBeNull();
    expect(isDestructiveCommand("python3 --check-hash-based-pycs always -m json.tool f.json")).toBe(true);
  });
});

describe("I2 — deno script operand after value-taking options (R62)", () => {
  // deno run is also stopped by the eval rules; this pins D1's own verdict.
  it("names no script after --config", async () => {
    const { repositoryScriptRun } = await import("../../core/shell/repo-scripts.ts");
    expect(repositoryScriptRun("deno run --config scripts/r.ts other.ts")?.script).toBeNull();
    expect(repositoryScriptRun("deno run --allow-read scripts/r.ts")?.script).toBe("scripts/r.ts");
    expect(repositoryScriptRun("deno run -A --unstable-kv scripts/r.ts")?.script).toBe("scripts/r.ts");
    expect(repositoryScriptRun("perl -I scripts/r.pl other.pl")?.script).toBeNull();
    expect(repositoryScriptRun("ruby -w scripts/r.rb")?.script).toBe("scripts/r.rb");
  });
});

// I5 / R65 (cheap fail-closed parts, no live measurement): npm's help/fund
// open a configured browser/viewer; D1's subcommand-tool globals become
// allowlist-shaped (a config selector or any unknown global stops); bun's
// inline eval loads bunfig.toml `preload` from the repository.
describe("I5 — config-driven execution in reader rows (R65)", () => {
  it.each([
    "npm help ls",
    "npm help-search foo",
    "npm fund",
    "npm --userconfig=./x ls",
    "npm --globalconfig=./x ls",
    "npm --userconfig ./x ls",
    "npm --foo=bar ls",
    "pnpm --config.x=y list",
    "pnpm --dir=sub list",
    "go -C=x version",
    "cargo --config=x version",
    "cargo -Zx version",
    "npm +x ls",
    "bun -e 'console.log(1)'",
    "bun -p 1",
    "bun --eval 'console.log(1)'",
    "bun --print 1",
  ])("%j is mutating", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(["npm ls", "npm -g ls", "npm --json ls", "npm view left-pad", "pnpm -r list", "cargo -q version", "go version", "bun --version"])(
    "%j stays read-only", (c) => expect(findDestructiveToken(c)).toBeNull());
});
