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
} from "./heads.ts";

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

/** Shell builtins whose operands set (and may export) variables. */
const DECLARATION_HEADS = new Set(["export", "declare", "typeset", "readonly", "local"]);

/** Every interpreter preload variable, whichever interpreter reads it. */
const PRELOAD_ENV_NAMES: ReadonlySet<string> = new Set(
  Object.values(INTERPRETER_PRELOAD_ENV).flatMap((names) => [...names]),
);

/** Whether a variable, set to `value` (undefined: unknown), can make a later command run code. */
function commandBearingEnvironment(name: string, value: string | undefined): boolean {
  if (lessEnvironmentWrite(name, value)) return true;
  if (PRELOAD_ENV_NAMES.has(name)) return true;
  return gitEnvironmentPrefixMutation([`${name}=`]) !== null;
}

/**
 * The command-bearing variable a segment sets, if any: a bare assignment
 * segment (`LESSOPEN=x`) or a declaration builtin operand (`export X=1`,
 * `declare -x X`, `export X`). Options (`-x`, `+x`, `--`) are skipped.
 */
export function commandBearingEnvironmentSetting(segment: string): string | null {
  const normalized = normalizeEnvInvocation(tokenizeShellWords(segment, ARGV));
  if (!normalized.complete) return null;
  let settings: readonly string[];
  // Assignments (`NAME=v`, `NAME+=v`, `NAME[i]=v`) name the bare variable;
  // an append leaves the final value unknown. A bare operand (`export NAME`,
  // `declare -x NAME[0]`) sets an unknown value.
  if (normalized.argv.length === 0) settings = normalized.assignments;
  else if (DECLARATION_HEADS.has(normalized.argv[0]!.replace(/^.*\//, ""))) {
    settings = normalized.argv.slice(1).filter((operand) => !/^[-+]/.test(operand));
  } else return null;
  for (const setting of settings) {
    const assignment = ENV_ASSIGNMENT_RE.exec(setting);
    const name = assignment ? assignment[1]! : setting.replace(/\[.*$/s, "");
    const value = assignment && !isAppendAssignment(setting) ? assignment[2] : undefined;
    if (commandBearingEnvironment(name, value)) return name;
  }
  return null;
}

/** Return a command-bearing assignment inherited by a shell `-c` payload. */
export function shellEnvironmentPrefixMutation(segment: string): string | null {
  const normalized = normalizeEnvInvocation(tokenizeShellWords(segment, ARGV));
  return normalized.complete ? gitEnvironmentPrefixMutation(normalized.assignments) : null;
}
