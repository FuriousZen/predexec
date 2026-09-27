/**
 * predexec core — operands that come from data (E-B).
 *
 * PURE TS, imports nothing outside core/. A host deny rule such as
 * `Bash(cat .env)` or `read: {".env": "deny"}` is matched against the literal
 * command text. When a command's operand is produced at run time, that text
 * never names the file: `echo .env | xargs cat`, `while read f; do cat "$f";
 * done < list`, and `cat $(cat names.txt)` all read `.env` through a command
 * whose spelling no rule can see. This module reports every command whose
 * operands are decided at run time, so each host policy reader can stop it
 * when one of its rules could have matched.
 *
 * Four sources, each reported with the effective command (`head`) that
 * receives the data:
 * - `xargs`: every command xargs runs gets its operands from stdin.
 * - `read-loop`: an operand referencing a variable a `read` in the same
 *   command assigns.
 * - `substitution-operand`: an operand holding `$(…)` or a backtick.
 * - `variable-operand`: any other operand the shell expands (`$f`, `${f}`,
 *   `$1`, `$((…))`).
 *
 * Words before the head (assignments, wrappers) are not operands, and a
 * here-document or here-string feeds stdin, not a file name, so neither
 * counts. Over-approximation is the safe direction: a reported command only
 * stops when a host rule could have matched it.
 */

import {
  ARGV,
  inspectCommandSubstitutionTree,
  lexShellWords,
  normalizeEnvInvocation,
  splitCommandSegments,
  stripLeadingAssignmentsAndWrappers,
  stripLeadingReservedWords,
} from "./lexer.ts";

export type UnresolvableOperandReason = "xargs" | "read-loop" | "substitution-operand" | "variable-operand";

export interface UnresolvableOperand {
  /** Basename of the command that receives the data-fed operand. */
  head: string;
  /** The shell clause it was found in. */
  clause: string;
  reason: UnresolvableOperandReason;
}

/** A clause header whose words are loop/case syntax, not a command and its operands. */
const HEADER_RE = /^(?:(?:if|then|elif|else|while|until|do|!|\{)\s+)*(?:for|select|case)(?=\s|$)/;
const SUBSTITUTION_RE = /\$\((?!\()|`/;
const REFERENCE_RE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
/** `read` options whose value is the next word (or the rest of the cluster). */
const READ_VALUE_OPTIONS = new Set(["a", "d", "i", "n", "N", "p", "t", "u"]);
/** Here-document / here-string operators: the next word is a delimiter or stdin data. */
const HERE_OPERATOR_RE = /^\d*<<(?:<|-)?$/;
const HERE_ATTACHED_RE = /^\d*<<(?:<|-)?./;

const XARGS_WORD_RE = /(?:^|[\s/])xargs(?=\s|$)/;
const basename = (word: string): string => word.replace(/^.*\//, "");

/**
 * xargs (GNU + BSD) options. A letter mapped to `true` takes a value (attached,
 * or else the next word); `"attached"` takes only an attached value; `false` is
 * a plain flag.
 */
const XARGS_SHORT: Readonly<Record<string, boolean | "attached">> = {
  "0": false, p: false, r: false, t: false, x: false, o: false,
  a: true, d: true, E: true, I: true, J: true, L: true, n: true, P: true, R: true, s: true, S: true,
  e: "attached", i: "attached", l: "attached",
};
const XARGS_LONG_VALUE = new Set(["--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"]);
const XARGS_LONG_OPTIONAL = new Set(["--eof", "--replace", "--max-lines"]);
const XARGS_LONG_FLAGS = new Set([
  "--null", "--interactive", "--no-run-if-empty", "--verbose", "--exit", "--open-tty", "--show-limits", "--help", "--version",
]);

/**
 * The command words xargs runs, from the words after `xargs`. `null` when an
 * option is not recognized: the caller then treats every later non-option word
 * as a possible command.
 */
function xargsCommand(args: readonly string[]): string[] | null {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") return args.slice(i + 1);
    if (!arg.startsWith("-") || arg === "-") return args.slice(i);
    if (arg.startsWith("--")) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (XARGS_LONG_VALUE.has(name)) i += arg.includes("=") ? 1 : 2;
      else if (XARGS_LONG_OPTIONAL.has(name) || XARGS_LONG_FLAGS.has(name)) i += 1;
      else return null;
      continue;
    }
    let consumed = 1;
    for (let j = 1; j < arg.length; j++) {
      const kind = XARGS_SHORT[arg[j]!];
      if (kind === undefined) return null;
      if (kind === "attached") break;
      if (kind === true) {
        if (j === arg.length - 1) consumed = 2;
        break;
      }
    }
    i += consumed;
  }
  return [];
}

/** Heads of the command xargs runs: one when its options parse, every candidate when not. */
function xargsHeads(args: readonly string[]): string[] {
  const command = xargsCommand(args);
  if (command === null) {
    return args.filter((word) => word !== "" && !word.startsWith("-")).map(basename).filter(Boolean);
  }
  if (command.length === 0) return ["echo"];
  const normalized = normalizeEnvInvocation(command);
  const head = normalized.complete ? normalized.argv[0] : command[0];
  return [basename(head ?? command[0]!) || command[0]!];
}

/** Variable names a `read` segment assigns (`REPLY` when it names none). */
function readNames(argv: readonly string[]): string[] {
  const names: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      names.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j]!;
        if (!READ_VALUE_OPTIONS.has(letter)) continue;
        const value = j === arg.length - 1 ? argv[++i] : arg.slice(j + 1);
        if (letter === "a" && value !== undefined) names.push(value);
        break;
      }
      continue;
    }
    names.push(arg);
  }
  return names.length > 0 ? names : ["REPLY"];
}

interface Clause {
  text: string;
  words: ReturnType<typeof lexShellWords>["words"];
  /** Index of the effective head within `words`, or -1 when it cannot be mapped back. */
  headIndex: number;
  argv: string[];
}

function inspectClause(segment: string): Clause | null {
  if (HEADER_RE.test(segment.trim())) return null;
  const text = stripLeadingReservedWords(segment);
  if (!text || text.startsWith("(")) return null;
  const words = lexShellWords(text, ARGV).words;
  const values = words.map((word) => word.value);
  const normalized = normalizeEnvInvocation(values);
  if (!normalized.complete) return null;
  // No command left (bare `xargs`, `env`): every word was a prefix.
  if (normalized.argv.length === 0) return { text, words, headIndex: words.length, argv: [] };
  const offset = values.length - normalized.argv.length;
  const mapped = offset >= 0 && values[offset] === normalized.argv[0];
  return { text, words, headIndex: mapped ? offset : -1, argv: normalized.argv };
}

function clausesOf(command: string): string[] {
  const out: string[] = [];
  for (const body of inspectCommandSubstitutionTree(command).commands) {
    for (const segment of splitCommandSegments(body)) {
      if (segment.trim()) out.push(segment.trim());
    }
  }
  return out;
}

/**
 * Every command whose operands come from data, with the reason. Pure and
 * bounded by the shared substitution-tree budgets; a command it cannot
 * inspect is left to the checkers' own incomplete-syntax stops.
 */
export function commandsWithUnresolvableOperands(command: string): UnresolvableOperand[] {
  const clauses = clausesOf(command).map((text) => ({ segment: text, clause: inspectClause(text) }));
  const readVariables = new Set<string>();
  for (const { clause } of clauses) {
    if (clause && basename(clause.argv[0] ?? "") === "read") for (const name of readNames(clause.argv)) readVariables.add(name);
  }
  const out: UnresolvableOperand[] = [];
  const seen = new Set<string>();
  const add = (entry: UnresolvableOperand) => {
    const key = `${entry.head}\u0000${entry.reason}\u0000${entry.clause}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  for (const { segment, clause } of clauses) {
    if (!clause) continue;
    const head = basename(clause.argv[0] ?? "") || (clause.argv[0] ?? "");
    // xargs is a wrapper to the normalizer, so it sits before the head.
    const prefix = clause.headIndex === -1 ? [] : clause.words.slice(0, clause.headIndex);
    const xargsAt = prefix.map((word) => basename(word.value)).lastIndexOf("xargs");
    if (xargsAt !== -1) {
      const args = clause.words.slice(xargsAt + 1).map((word) => word.value);
      for (const target of xargsHeads(args)) add({ head: target, clause: segment, reason: "xargs" });
    } else if (clause.headIndex === -1 && clause.words.some((word) => XARGS_WORD_RE.test(word.value))) {
      // An `env -S 'xargs cat'` payload: the normalized argv is what xargs runs.
      for (const target of xargsHeads(clause.argv)) add({ head: target, clause: segment, reason: "xargs" });
    }
    const operands = clause.headIndex === -1 ? clause.words : clause.words.slice(clause.headIndex + 1);
    for (let i = 0; i < operands.length; i++) {
      const word = operands[i]!;
      if (HERE_OPERATOR_RE.test(word.value)) {
        i++;
        continue;
      }
      if (HERE_ATTACHED_RE.test(word.value) || !word.dynamic) continue;
      const raw = clause.text.slice(word.start, word.end);
      const references = [...raw.matchAll(REFERENCE_RE)].map((match) => match[1]!);
      const reason: UnresolvableOperandReason = SUBSTITUTION_RE.test(raw)
        ? "substitution-operand"
        : references.some((name) => readVariables.has(name)) ? "read-loop" : "variable-operand";
      add({ head, clause: segment, reason });
      break;
    }
  }
  return out;
}

/**
 * Commands whose operands are never file paths. A path-read host rule
 * (Claude `Read()`, opencode `read`, Antigravity `read_file`) cannot be
 * bypassed through them, so a data-fed operand of one needs no stop.
 */
const PATH_FREE_HEADS: ReadonlySet<string> = new Set([
  "echo", "printf", "test", "[", "[[", "true", "false", ":", "read", "export", "declare", "local", "typeset",
  "readonly", "set", "unset", "shift", "return", "exit", "let", "cd", "pushd", "popd", "wait", "sleep",
  "basename", "dirname", "seq", "expr",
]);

/** False only for commands whose operands are never file paths (see `PATH_FREE_HEADS`). */
export function operandHeadMayReadPaths(head: string): boolean {
  return !PATH_FREE_HEADS.has(head);
}

export interface RuleHeadOptions {
  /** `*`/`?` in a rule word are wildcards (Claude, opencode). Default true. */
  glob?: boolean;
}

function globMatches(pattern: string, value: string): boolean {
  const body = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]");
  return new RegExp(`^${body}$`).test(value);
}

/**
 * Could a host rule whose command pattern is `words` match a command run by
 * `head`? True when the pattern's first word — as written, or after the
 * wrappers and assignments core strips — is `head` (compared by basename), or
 * a wildcard that matches it. An empty pattern matches every command.
 */
export function ruleHeadCouldMatch(words: readonly string[], head: string, options: RuleHeadOptions = {}): boolean {
  if (words.length === 0) return true;
  const glob = options.glob !== false;
  const stripped = stripLeadingAssignmentsAndWrappers(words);
  const candidates = [words[0]!, ...(stripped.length > 0 ? [stripped[0]!] : [])];
  return candidates.some((word) => {
    const base = basename(word) || word;
    return glob ? globMatches(base, head) || globMatches(word, head) : base === head;
  });
}

const REASON_TEXT: Record<UnresolvableOperandReason, string> = {
  xargs: "xargs supplies them from its input",
  "read-loop": "they come from a variable `read` assigns",
  "substitution-operand": "they come from a command substitution",
  "variable-operand": "they come from a variable",
};

/** The policyStop text for one unresolvable-operand command, naming what it cannot be checked against. */
export function describeUnresolvableOperand(entry: UnresolvableOperand, against: string): string {
  const clause = entry.clause.length > 120 ? `${entry.clause.slice(0, 117)}...` : entry.clause;
  return `the operands of '${entry.head}' in "${clause}" can't be checked against ${against}: ` +
    `${REASON_TEXT[entry.reason]} — name the file literally`;
}
