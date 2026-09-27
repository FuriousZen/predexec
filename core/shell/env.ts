/**
 * Command-bearing environment variables for the destructive-command heuristic
 * (core/destructive.ts): interpreter preload variables (NODE_OPTIONS, PERL5OPT,
 * RUBYOPT, ...), LESSOPEN-style reader hooks, and Git's command-bearing
 * variables. Setting or exporting one changes what a later "reader" executes,
 * so it counts as a mutation of the environment the command runs in.
 */

import {
  ARGV,
  ENV_ASSIGNMENT_RE,
  isAppendAssignment,
  normalizeEnvInvocation,
  tokenizeShellWords,
} from "./lexer.ts";
import {
  gitEnvironmentPrefixMutation,
} from "./git.ts";
import {
  lessEnvironmentWrite,
  MAN_COMMAND_ENV,
} from "./heads.ts";
import { arithmeticAssignedNames } from "./taint.ts";

/**
 * Directories whose executables are system or package-manager installs, not
 * repository files. The classifier does not know the session root, so any
 * other absolute path may be inside the checkout and fails closed (R38).
 */
export const SYSTEM_PREFIXES: readonly string[] = ["/usr/", "/bin/", "/sbin/", "/opt/homebrew/", "/nix/store/"];

/**
 * R39: whether a new PATH value can resolve a bare head to a repository file.
 * Every `:` component must be `$PATH`/`${PATH}` or a plain absolute directory
 * under SYSTEM_PREFIXES; an empty component or `.` (the cwd), a relative or
 * `~` path, a `.`/`..` segment, any other expansion, or an unknown value
 * (`PATH+=…`, a bare `export PATH`) fails closed.
 */
export function pathValueCommandBearing(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value.split(":").some((component) => {
    if (component === "$PATH" || component === "${PATH}") return false;
    if (/[$`~]/.test(component) || !component.startsWith("/")) return true;
    if (/(?:^|\/)\.\.?(?:\/|$)/.test(component)) return true;
    const dir = component.endsWith("/") ? component : `${component}/`;
    return !SYSTEM_PREFIXES.some((prefix) => dir.startsWith(prefix));
  });
}

/**
 * Environment variables that make an interpreter load code or options before
 * the eval program (`NODE_OPTIONS='"--require" x'`, `PERL5OPT=-Mevil`, an ini
 * `auto_prepend_file` via PHPRC). Any value is refused: their parsers (quote
 * stripping, option splicing) are not worth re-implementing to find a safe one.
 */
export const INTERPRETER_PRELOAD_ENV: Record<string, ReadonlySet<string>> = {
  node: new Set(["NODE_OPTIONS"]),
  bun: new Set(["NODE_OPTIONS", "BUN_OPTIONS"]),
  deno: new Set(["NODE_OPTIONS", "DENO_OPTIONS"]),
  perl: new Set(["PERL5OPT", "PERL5LIB", "PERLLIB"]),
  ruby: new Set(["RUBYOPT", "RUBYLIB"]),
  php: new Set(["PHPRC", "PHP_INI_SCAN_DIR"]),
  python: new Set(["PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME"]),
  python3: new Set(["PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME"]),
};

/**
 * Loader and shell/interpreter startup variables that run code in whatever
 * process inherits them, whichever command that is: dynamic-linker preloads
 * (`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, library search paths), shell
 * startup files (`BASH_ENV`, POSIX `ENV`), `PYTHONWARNINGS`, whose
 * category field imports a module, and build-tool variables that name a
 * program to run or flags that do (`RUSTC_WRAPPER`, `GOFLAGS=-toolexec=…`,
 * `MAKEFLAGS=--eval=…`; `npm_config_*` via isDangerousEnv). Any value, any
 * head, any setting form.
 */
export const DANGEROUS_ENV: ReadonlySet<string> = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "BASH_ENV",
  "ENV",
  "PYTHONWARNINGS",
  "RUSTC",
  "RUSTC_WRAPPER",
  "CARGO_BUILD_RUSTC",
  "CARGO_BUILD_RUSTC_WRAPPER",
  "GOFLAGS",
  "MAKEFLAGS",
  "MFLAGS",
  // R44: where tools find their configuration (git's ~/.gitconfig, zsh's
  // startup files, every XDG-config reader).
  "HOME",
  "ZDOTDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_DIRS",
]);

/**
 * DANGEROUS_ENV, plus every npm config variable: npm reads any
 * `npm_config_<key>` (either case) as config, and keys such as `script-shell`
 * and `node-options` choose what runs.
 */
export function isDangerousEnv(name: string): boolean {
  return DANGEROUS_ENV.has(name) || /^npm_config_/i.test(name);
}

/** Shell builtins whose operands set (and may export) variables. */
const DECLARATION_HEADS = new Set(["export", "declare", "typeset", "readonly", "local"]);

/** Every interpreter preload variable, whichever interpreter reads it. */
const PRELOAD_ENV_NAMES: ReadonlySet<string> = new Set(
  Object.values(INTERPRETER_PRELOAD_ENV).flatMap((names) => [...names]),
);

/** Whether a variable, set to `value` (undefined: unknown), can make a later command run code. */
function commandBearingEnvironment(name: string, value: string | undefined): boolean {
  if (lessEnvironmentWrite(name, value)) return true;
  if (MAN_COMMAND_ENV.has(name)) return true;
  if (PRELOAD_ENV_NAMES.has(name) || isDangerousEnv(name)) return true;
  if (name === "PATH" && pathValueCommandBearing(value)) return true;
  return gitEnvironmentPrefixMutation([`${name}=`]) !== null;
}

/**
 * The command-bearing variable a segment sets, if any: a bare assignment
 * segment (`LESSOPEN=x`) or a declaration builtin operand (`export X=1`,
 * `declare -x X`, `export X`). Options (`-x`, `+x`, `--`) are skipped. A
 * DANGEROUS_ENV variable also counts as a command prefix or `env` operand
 * (`LD_PRELOAD=x cat f`), since it acts on any head.
 */
export function commandBearingEnvironmentSetting(segment: string): string | null {
  const normalized = normalizeEnvInvocation(tokenizeShellWords(segment, ARGV));
  if (!normalized.complete) return null;
  for (const assignment of normalized.assignments) {
    const match = ENV_ASSIGNMENT_RE.exec(assignment);
    const name = match?.[1];
    if (name && isDangerousEnv(name)) return name;
    // PATH picks the program behind every later bare head, the prefixed one included.
    if (name === "PATH" && pathValueCommandBearing(isAppendAssignment(assignment) ? undefined : match![2])) return name;
  }
  let settings: readonly string[];
  // Assignments (`NAME=v`, `NAME+=v`, `NAME[i]=v`) name the bare variable;
  // an append leaves the final value unknown. A bare operand (`export NAME`,
  // `declare -x NAME[0]`) sets an unknown value.
  if (normalized.argv.length === 0) settings = normalized.assignments;
  else if (DECLARATION_HEADS.has(normalized.argv[0]!.replace(/^.*\//, ""))) {
    const operands = normalized.argv.slice(1);
    settings = operands.filter((operand) => !/^[-+]/.test(operand));
    // A nameref (`declare -n r=PATH`) makes every later `r=…` write its
    // target: a command-bearing, dynamic or not-yet-given target stops.
    if (operands.some((operand) => /^-[A-Za-z]*n/.test(operand))) {
      for (const setting of settings) {
        const assignment = ENV_ASSIGNMENT_RE.exec(setting);
        const target = assignment?.[2];
        if (target === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) return "nameref";
        if (commandBearingEnvironment(target, undefined)) return target;
      }
    }
  } else return assigningBuiltinTarget(normalized.argv);
  for (const setting of settings) {
    const assignment = ENV_ASSIGNMENT_RE.exec(setting);
    const name = assignment ? assignment[1]! : setting.replace(/\[.*$/s, "");
    const value = assignment && !isAppendAssignment(setting) ? assignment[2] : undefined;
    if (commandBearingEnvironment(name, value)) return name;
  }
  return null;
}

/**
 * R40: builtins that assign the variables named in their argv, with the
 * short options that take a value. Bash builtins stop option parsing at the
 * first operand.
 */
const ASSIGNING_BUILTINS: Readonly<Record<string, { valueLetters: string; names: (operands: string[], values: Map<string, string[]>) => string[] }>> = {
  read: { valueLetters: "adinNptu", names: (operands, values) => [...operands, ...(values.get("a") ?? [])] },
  mapfile: { valueLetters: "dnOsuCc", names: (operands) => operands },
  readarray: { valueLetters: "dnOsuCc", names: (operands) => operands },
  getopts: { valueLetters: "", names: (operands) => operands.slice(1, 2) },
  printf: { valueLetters: "v", names: (_operands, values) => values.get("v") ?? [] },
  // R43: unsetting PATH makes bash look bare names up in the cwd.
  unset: { valueLetters: "", names: (operands) => operands },
  // `let` expressions: every variable they name (a read of PATH there is
  // no read worth keeping).
  let: { valueLetters: "", names: (operands) => operands.flatMap((operand) => operand.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) },
};

/**
 * The command-bearing variable a `read`/`mapfile`/`getopts`/`printf -v` sets,
 * or `<head> dynamic variable` when a target name is an expansion. Their
 * values come from data, so the value is unknown.
 */
function assigningBuiltinTarget(argv: readonly string[]): string | null {
  const head = argv[0]!.replace(/^.*\//, "");
  if (!Object.hasOwn(ASSIGNING_BUILTINS, head)) return null;
  const spec = ASSIGNING_BUILTINS[head]!;
  const values = new Map<string, string[]>();
  let i = 1;
  for (; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === "--") { i++; break; }
    if (!/^-./.test(word)) break;
    for (let j = 1; j < word.length; j++) {
      const letter = word[j]!;
      if (!spec.valueLetters.includes(letter)) continue;
      const value = word.slice(j + 1) || argv[++i];
      if (value !== undefined) values.set(letter, [...(values.get(letter) ?? []), value]);
      break;
    }
  }
  // printf's operands are its format and arguments, not names.
  const operands = head === "printf" ? [] : argv.slice(i);
  for (const name of spec.names(operands, values)) {
    if (/[$`]/.test(name)) return `${head} dynamic variable`;
    const bare = name.replace(/\[.*$/s, "");
    if (commandBearingEnvironment(bare, undefined)) return bare;
  }
  return null;
}

/** Whether writing `name` (any value) can make a later command run code. */
export function isCommandBearingName(name: string): boolean {
  return commandBearingEnvironment(name, undefined);
}

/**
 * R43 (a): command-bearing names written by constructs that are not an
 * assignment word or a builtin's argv — a `for`/`select` loop variable, a
 * `${NAME:=…}`/`${NAME=…}` expansion, and any variable assigned in an
 * arithmetic context (`(( PATH = 0 ))`, `[[ 1 -eq PATH=0 ]]`, `a[PATH=0]`,
 * `${x:PATH=0}`, an integer-declared name's value; see taint.ts). `loopHeaders` are the
 * command texts that start with `for`/`select` (from the shared walker). The
 * expansion and arithmetic scans read the raw text, quotes included, which
 * can only over-stop.
 */
export function commandBearingNameWrite(text: string, loopHeaders: readonly string[]): string | null {
  for (const header of loopHeaders) {
    const name = /^(?:for|select)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(header)?.[1];
    if (name && commandBearingEnvironment(name, undefined)) return name;
  }
  for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?:?=/g)) {
    if (commandBearingEnvironment(match[1]!, undefined)) return match[1]!;
  }
  // R44: every arithmetic context taint.ts knows, and the names it assigns.
  for (const name of arithmeticAssignedNames(text).names) {
    if (commandBearingEnvironment(name, undefined)) return name;
  }
  return null;
}

/** Return a command-bearing assignment inherited by a shell `-c` payload. */
export function shellEnvironmentPrefixMutation(segment: string): string | null {
  const normalized = normalizeEnvInvocation(tokenizeShellWords(segment, ARGV));
  return normalized.complete ? gitEnvironmentPrefixMutation(normalized.assignments) : null;
}
