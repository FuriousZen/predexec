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

import { EVAL_SHELLS, shellEvalPayload } from "./interpreters.ts";
import {
  ARGV,
  inspectCommandSubstitutionTree,
  lexShellWords,
  normalizeEnvInvocation,
  splitCommandSegments,
  stripLeadingAssignmentsAndWrappers,
  stripLeadingReservedWords,
} from "./lexer.ts";

export type UnresolvableOperandReason =
  | "xargs"
  | "find-exec"
  | "parallel"
  | "read-loop"
  | "substitution-operand"
  | "variable-operand";

export interface UnresolvableOperand {
  /**
   * Basename of the command that receives the data-fed operand, or
   * `ANY_HEAD` when the command itself could not be determined (every rule
   * could match it).
   */
  head: string;
  /** The shell clause it was found in. */
  clause: string;
  reason: UnresolvableOperandReason;
}

/** The head of a data-fed command predexec could not determine: every host rule could match it. */
export const ANY_HEAD = "*";

/** A clause header whose words are loop/case syntax, not a command and its operands. */
const HEADER_RE = /^(?:(?:if|then|elif|else|while|until|do|!|\{)\s+)*(?:for|select|case)(?=\s|$)/;
/** The part of a `for`/`select` header the clause inspector also yields on its own (`f in $(…)`). */
const LOOP_HEADER_RE = /^(?:(?:if|then|elif|else|while|until|do|!|\{)\s+)*(?:for|select)\s+([\s\S]*)$/;
const SUBSTITUTION_RE = /\$\((?!\()|`/;
const REFERENCE_RE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
/** `read` options whose value is the next word (or the rest of the cluster). */
const READ_VALUE_OPTIONS = new Set(["a", "d", "i", "n", "N", "p", "t", "u"]);
/** Here-document / here-string operators: the next word is a delimiter or stdin data. */
const HERE_OPERATOR_RE = /^\d*<<(?:<|-)?$/;
const HERE_ATTACHED_RE = /^\d*<<(?:<|-)?./;
/** Nesting bound for launchers inside launchers (`xargs sh -c 'find … -exec …'`). */
const MAX_FED_DEPTH = 6;

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
 * Index (into `args`, the words after `xargs`) where the command xargs runs
 * starts; `args.length` when it runs none (`echo`). `null` when an option is
 * not recognized.
 */
function xargsCommandIndex(args: readonly string[]): number | null {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") return i + 1;
    if (!arg.startsWith("-") || arg === "-") return i;
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
  return args.length;
}

/** Every later non-option word, when a launcher's options could not be parsed. */
function candidateHeads(args: readonly string[]): string[] {
  return args.filter((word) => word !== "" && !word.startsWith("-")).map(basename).filter(Boolean);
}

/**
 * GNU parallel options. Short value options take an attached value or the
 * next word; short flags may cluster. Anything else is not parsed confidently.
 */
const PARALLEL_SHORT_VALUE = new Set(["a", "b", "C", "d", "E", "I", "j", "L", "l", "n", "N", "P", "s", "S"]);
const PARALLEL_SHORT_FLAGS = new Set(["0", "k", "q", "r", "t", "u", "v", "X", "m", "g", "Z"]);
const PARALLEL_LONG_VALUE = new Set([
  "--arg-file", "--block", "--block-size", "--colsep", "--delimiter", "--eof", "--replace", "--jobs", "--max-procs",
  "--max-lines", "--max-args", "--max-chars", "--sshlogin", "--sshloginfile", "--slf", "--joblog", "--results", "--res",
  "--tmpdir", "--tempdir", "--timeout", "--delay", "--retries", "--halt", "--memfree", "--load", "--workdir", "--wd",
  "--basefile", "--bf", "--env", "--tag-string", "--tagstring", "--return", "--transferfile", "--tf", "--sshdelay",
  "--limit", "--header", "--trim", "--rpl", "--nice", "--termseq", "--shellquote-arg",
]);
const PARALLEL_LONG_FLAGS = new Set([
  "--null", "--keep-order", "--quote", "--xargs", "--ungroup", "--group", "--no-run-if-empty", "--dry-run", "--dryrun",
  "--tag", "--pipe", "--spreadstdin", "--pipepart", "--progress", "--bar", "--eta", "--line-buffer", "--lb",
  "--will-cite", "--no-notice", "--verbose", "--shuf", "--plus", "--noswap", "--files", "--silent", "--onall",
  "--nonall", "--cat", "--fifo", "--compress", "--linebuffer", "--keeporder", "--group-by", "--transfer", "--cleanup",
]);
const PARALLEL_SEPARATOR_RE = /^::::?\+?$/;

/**
 * The span of words (indices into `args`, the words after `parallel`) of
 * the command parallel runs, or null when its argv is not parsed confidently
 * or it runs its input lines as commands (no command before the first `:::`).
 */
function parallelCommandSpan(args: readonly string[]): { start: number; end: number } | null {
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      i++;
      break;
    }
    if (!arg.startsWith("-") || arg === "-" || PARALLEL_SEPARATOR_RE.test(arg)) break;
    if (arg.startsWith("--")) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (PARALLEL_LONG_VALUE.has(name)) {
        if (!arg.includes("=")) i++;
      } else if (!PARALLEL_LONG_FLAGS.has(name)) {
        return null;
      }
      continue;
    }
    const letters = arg.slice(1);
    if (PARALLEL_SHORT_VALUE.has(letters[0]!)) {
      if (letters.length === 1) i++;
      continue;
    }
    if (![...letters].every((letter) => PARALLEL_SHORT_FLAGS.has(letter))) return null;
  }
  let end = i;
  while (end < args.length && !PARALLEL_SEPARATOR_RE.test(args[end]!)) end++;
  return end > i ? { start: i, end } : null;
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

/** A clause's command, `"skip"` for syntax that runs nothing, or null when it cannot be placed. */
function inspectClause(segment: string): Clause | "skip" | null {
  if (HEADER_RE.test(segment.trim())) return "skip";
  const text = stripLeadingReservedWords(segment);
  if (!text || text.startsWith("(")) return "skip";
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

const headOf = (clause: Clause): string => basename(clause.argv[0] ?? "") || (clause.argv[0] ?? "");

/** Every command clause in `command`, without the `name in …` part of a `for`/`select` header. */
function clausesOf(command: string): string[] {
  const segments: string[] = [];
  for (const body of inspectCommandSubstitutionTree(command).commands) {
    for (const segment of splitCommandSegments(body)) {
      if (segment.trim()) segments.push(segment.trim());
    }
  }
  const loopHeaders = new Set<string>();
  for (const segment of segments) {
    const header = LOOP_HEADER_RE.exec(segment);
    if (header) loopHeaders.add(header[1]!.trim());
  }
  return segments.filter((segment) => !loopHeaders.has(segment));
}

type FedHead = { head: string; reason: UnresolvableOperandReason };

/** Source text of `clause.words[from..to)`. */
const spanText = (clause: Clause, from: number, to: number): string =>
  clause.text.slice(clause.words[from]!.start, clause.words[to - 1]!.end);

/**
 * The heads of a command a launcher runs with data-fed operands: its own head,
 * the clauses of a shell `-c` payload it runs (the payload's `{}` or `$1` is
 * the data), and whatever it launches in turn.
 */
function fedHeads(text: string, reason: UnresolvableOperandReason, depth: number): FedHead[] {
  if (depth > MAX_FED_DEPTH) return [{ head: ANY_HEAD, reason }];
  const clause = inspectClause(text);
  if (clause === "skip") return [];
  if (clause === null) return [{ head: ANY_HEAD, reason }];
  if (clause.argv.length === 0) return [{ head: "echo", reason }];
  const head = headOf(clause);
  const out: FedHead[] = [{ head, reason }];
  if (EVAL_SHELLS.has(head)) {
    const shell = shellEvalPayload(clause.text);
    if (shell?.payload != null) {
      for (const inner of clausesOf(shell.payload)) out.push(...fedHeads(inner, reason, depth + 1));
    } else if (shell?.ambiguous) {
      out.push({ head: ANY_HEAD, reason });
    }
  }
  out.push(...launchedHeads(clause, depth + 1));
  return out;
}

/** Commands this clause launches with data-fed operands: via xargs, `find -exec`, or parallel. */
function launchedHeads(clause: Clause, depth: number): FedHead[] {
  const out: FedHead[] = [];
  const head = headOf(clause);
  // xargs is a wrapper to the normalizer, so it sits before the head.
  const prefix = clause.headIndex === -1 ? [] : clause.words.slice(0, clause.headIndex);
  const xargsAt = prefix.map((word) => basename(word.value)).lastIndexOf("xargs");
  if (xargsAt !== -1) {
    const args = clause.words.slice(xargsAt + 1).map((word) => word.value);
    const index = xargsCommandIndex(args);
    if (index === null) out.push(...candidateHeads(args).map((h) => ({ head: h, reason: "xargs" as const })));
    else if (index >= args.length) out.push({ head: "echo", reason: "xargs" });
    else out.push(...fedHeads(spanText(clause, xargsAt + 1 + index, clause.words.length), "xargs", depth));
  } else if (clause.headIndex === -1 && clause.words.some((word) => XARGS_WORD_RE.test(word.value))) {
    // An `env -S 'xargs cat'` payload: the normalized argv is what xargs runs.
    out.push(...candidateHeads(clause.argv).map((h) => ({ head: h, reason: "xargs" as const })));
  }
  if (head === "find") {
    if (clause.headIndex === -1) {
      if (clause.argv.some((arg) => /^-(?:exec|execdir|ok|okdir)$/.test(arg))) out.push({ head: ANY_HEAD, reason: "find-exec" });
      return out;
    }
    const words = clause.words;
    for (let i = clause.headIndex + 1; i < words.length; i++) {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(words[i]!.value)) continue;
      let end = i + 1;
      while (end < words.length && words[end]!.value !== ";" && !(words[end]!.value === "+" && words[end - 1]!.value === "{}")) end++;
      if (end > i + 1) out.push(...fedHeads(spanText(clause, i + 1, end), "find-exec", depth));
      i = end;
    }
  }
  if (head === "parallel") {
    const at = clause.headIndex;
    const span = at === -1 ? null : parallelCommandSpan(clause.words.slice(at + 1).map((word) => word.value));
    if (span === null) out.push({ head: ANY_HEAD, reason: "parallel" });
    else out.push(...fedHeads(spanText(clause, at + 1 + span.start, at + 1 + span.end), "parallel", depth));
  }
  return out;
}

/**
 * Every command whose operands come from data, with the reason, once per
 * head and reason. Pure and bounded by the shared substitution-tree budgets;
 * a command it cannot inspect is left to the checkers' own incomplete-syntax
 * stops.
 */
export function commandsWithUnresolvableOperands(command: string): UnresolvableOperand[] {
  const clauses = clausesOf(command).map((text) => ({ segment: text, clause: inspectClause(text) }));
  const readVariables = new Set<string>();
  for (const { clause } of clauses) {
    if (clause && clause !== "skip" && headOf(clause) === "read") for (const name of readNames(clause.argv)) readVariables.add(name);
  }
  const out: UnresolvableOperand[] = [];
  const seen = new Set<string>();
  const add = (entry: UnresolvableOperand) => {
    const key = `${entry.head}\u0000${entry.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  for (const { segment, clause } of clauses) {
    if (!clause || clause === "skip") continue;
    for (const fed of launchedHeads(clause, 0)) add({ ...fed, clause: segment });
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
      add({ head: headOf(clause), clause: segment, reason });
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

/** Longest head a glob is matched against; a longer one could match any `*` rule. */
const MAX_GLOB_HEAD = 256;

/**
 * Glob match (`*` any run, `?` one character) in O(pattern × value) with no
 * backtracking blow-up: the classic two-pointer walk that retries only from
 * the last `*`.
 */
function globMatches(pattern: string, value: string): boolean {
  if (value.length > MAX_GLOB_HEAD) return pattern.includes("*");
  let p = 0;
  let v = 0;
  let star = -1;
  let resume = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === value[v])) {
      p++;
      v++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      resume = v;
    } else if (star !== -1) {
      p = star + 1;
      v = ++resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Stands in for a rule word predexec cannot read (it matches every command). */
const UNKNOWN_WORD = "\u0000unknown";

/**
 * Could a host rule whose command pattern is `words` match a command run by
 * `head`? True when the pattern's first word — as written, or after the
 * wrappers and assignments core strips — is `head` (compared by basename), or
 * a wildcard that matches it. An empty pattern matches every command, a
 * `null` word (one the host reader cannot evaluate) in the head position
 * matches every command, and `ANY_HEAD` is matched by every rule.
 */
export function ruleHeadCouldMatch(
  words: readonly (string | null)[],
  head: string,
  options: RuleHeadOptions = {},
): boolean {
  if (words.length === 0 || head === ANY_HEAD) return true;
  const glob = options.glob !== false;
  const spelled = words.map((word) => word ?? UNKNOWN_WORD);
  const stripped = stripLeadingAssignmentsAndWrappers(spelled);
  const candidates = [spelled[0]!, ...(stripped.length > 0 ? [stripped[0]!] : [])];
  return candidates.some((word) => {
    if (word === UNKNOWN_WORD) return true;
    const base = basename(word) || word;
    return glob ? globMatches(base, head) || globMatches(word, head) : base === head;
  });
}

const REASON_TEXT: Record<UnresolvableOperandReason, string> = {
  xargs: "xargs supplies them from its input",
  "find-exec": "find supplies the paths it finds",
  parallel: "parallel supplies them from its input or argument lists",
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
