/**
 * predexec core — the one shell lexer.
 *
 * PURE TS, imports nothing outside core/. Every shell-syntax question core and
 * the policy adapters ask goes through here: argv tokenizing (one tokenizer,
 * `lexShellWords`), pipeline/clause splitting, parenthesized-body and
 * substitution walking, heredoc masking, and wrapper/assignment stripping.
 *
 * This module deliberately does not know about policy syntax, precedence, or
 * verdicts. Hosts supply their wrapper vocabulary to
 * `stripLeadingAssignmentsAndWrappers` so policy adapters retain ownership of
 * those semantics; core's own classifier vocabulary is `WRAPPERS`.
 */

import { MAX_COMMAND_LENGTH } from "../types.ts";

export interface WrapperInspectionOptions {
  wrappers?: ReadonlySet<string>;
  optionTakingWrappers?: ReadonlySet<string>;
  bareOnlyWrappers?: ReadonlySet<string>;
  /** Wrapper-specific options whose following token is an option argument. */
  optionArguments?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Wrapper-specific options whose argument is itself a command string. */
  splitStringOptions?: ReadonlyMap<string, ReadonlySet<string>>;
  durationPattern?: RegExp;
}

/**
 * A shell variable assignment word: `NAME=`, `NAME+=` (append) and
 * `NAME[subscript]=` / `NAME[subscript]+=` (array element) all assign.
 */
const TOKEN_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

/**
 * Defaults for callers that pass no host vocabulary, derived from core's
 * `WRAPPERS`. `command`/`builtin`/`xargs` are stripped only when bare
 * (`command -v foo` looks a command up; `xargs -n1 grep` is an xargs command).
 */
const DEFAULT_BARE_ONLY_WRAPPERS: ReadonlySet<string> = new Set(["command", "builtin", "xargs"]);
const wrapperOptions = (options: WrapperInspectionOptions = {}) => ({
  wrappers: options.wrappers ?? DEFAULT_STRIP_WRAPPERS,
  optionTakingWrappers: options.optionTakingWrappers ?? DEFAULT_OPTION_TAKING_WRAPPERS,
  bareOnlyWrappers: options.bareOnlyWrappers ?? DEFAULT_BARE_ONLY_WRAPPERS,
  optionArguments: options.optionArguments ?? DEFAULT_OPTION_ARGUMENTS,
  splitStringOptions: options.splitStringOptions ?? DEFAULT_SPLIT_STRING_OPTIONS,
  durationPattern: options.durationPattern ?? WRAPPER_DURATION_RE,
});

export interface CommandSubstitutionInspection {
  /** Bodies of complete, top-level substitutions in this command. */
  bodies: string[];
  /** False when quoting or executable substitution delimiters are incomplete. */
  complete: boolean;
}

export interface CommandSubstitutionTree {
  commands: string[];
  complete: boolean;
}

export interface ExecutableBodyTreeOptions {
  maxDepth?: number;
  maxCommands?: number;
  maxChars?: number;
  /** Maximum size of one command before any quote/control scanning begins. */
  maxCommandLength?: number;
}

/**
 * Inspect command substitutions without treating punctuation in shell quotes
 * as syntax. This is intentionally a small lexer, not a shell evaluator: the
 * body is returned unchanged and callers decide how to classify it.
 */
export function inspectCommandSubstitutions(command: string): CommandSubstitutionInspection {
  const inspected = substitutionBodySpans(command);
  return { bodies: inspected.bodies.map((body) => body.text), complete: inspected.complete };
}

function substitutionBodySpans(command: string): { bodies: SpannedBody[]; complete: boolean } {
  const bodies: SpannedBody[] = [];
  let quote: "'" | '"' | null = null;
  let complete = true;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        i++;
      } else if (ch === '"') {
        quote = null;
      } else if (ch === "`" ) {
        const end = findBacktickClose(command, i + 1);
        if (end === -1) return { bodies, complete: false };
        else {
          bodies.push({ text: command.slice(i + 1, end), start: i + 1, end });
          i = end;
        }
      } else if (ch === "$" && command[i + 1] === "(") {
        const close = findParenSubstitutionClose(command, i + 2);
        if (close === -1) return { bodies, complete: false };
        else {
          bodies.push({ text: command.slice(i + 2, close), start: i + 2, end: close });
          i = close;
        }
      }
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === '"') {
      quote = '"';
      continue;
    }
    if (ch === "`") {
      const end = findBacktickClose(command, i + 1);
      if (end === -1) return { bodies, complete: false };
      else {
        bodies.push({ text: command.slice(i + 1, end), start: i + 1, end });
        i = end;
      }
      continue;
    }
    if ((ch === "$" || ch === "<" || ch === ">") && command[i + 1] === "(") {
      const close = findParenSubstitutionClose(command, i + 2);
      if (close === -1) return { bodies, complete: false };
      else {
        bodies.push({ text: command.slice(i + 2, close), start: i + 2, end: close });
        i = close;
      }
    }
  }
  if (quote !== null) complete = false;
  return { bodies, complete };
}

function findBacktickClose(command: string, start: number): number {
  let quote: "'" | '"' | null = null;
  for (let i = start; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === "`") return i;
  }
  return -1;
}

function findParenSubstitutionClose(command: string, start: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  let backtick = false;
  for (let i = start; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (backtick) {
      if (ch === "`") backtick = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "`") {
      backtick = true;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Backwards-compatible body-only API. */
export function extractCommandSubstitutions(command: string): string[] {
  return inspectCommandSubstitutions(command).bodies;
}

/** Walk executable substitution bodies under explicit work/depth budgets. */
export function inspectCommandSubstitutionTree(
  command: string,
  options: ExecutableBodyTreeOptions = {},
): CommandSubstitutionTree {
  const maxDepth = options.maxDepth ?? 32;
  const maxCommands = options.maxCommands ?? 512;
  const maxChars = options.maxChars ?? 1_000_000;
  const maxCommandLength = Math.min(options.maxCommandLength ?? MAX_COMMAND_LENGTH, MAX_COMMAND_LENGTH);
  const commands: string[] = [];
  if (command.length > maxCommandLength) return { commands, complete: false };
  const pending: Array<{ text: string; depth: number; offset: number; sequence: number }> = [];
  let sequence = 0;
  const enqueue = (item: Omit<(typeof pending)[number], "sequence">): void => {
    pending.push({ ...item, sequence: sequence++ });
    let index = pending.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (queueBefore(pending[parent]!, pending[index]!)) break;
      [pending[parent], pending[index]] = [pending[index]!, pending[parent]!];
      index = parent;
    }
  };
  const dequeue = (): (typeof pending)[number] | undefined => {
    const first = pending[0];
    const last = pending.pop();
    if (last && pending.length > 0) {
      pending[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < pending.length && !queueBefore(pending[smallest]!, pending[left]!)) smallest = left;
        if (right < pending.length && !queueBefore(pending[smallest]!, pending[right]!)) smallest = right;
        if (smallest === index) break;
        [pending[index], pending[smallest]] = [pending[smallest]!, pending[index]!];
        index = smallest;
      }
    }
    return first;
  };
  enqueue({ text: command, depth: 0, offset: 0 });
  const seen = new Set<string>();
  const queued = new Set<string>([command]);
  let chars = 0;
  while (pending.length > 0) {
    const item = dequeue()!;
    if (seen.has(item.text)) continue;
    seen.add(item.text);
    if (commands.length >= maxCommands) return { commands, complete: false };
    if (item.text.length > maxCommandLength || chars + item.text.length > maxChars) {
      return { commands, complete: false };
    }
    const inspected = inspectCommandSubstitutions(item.text);
    const clauses = inspectShellCommandClauseEvents(item.text);
    commands.push(item.text);
    chars += item.text.length;
    if (!inspected.complete || !clauses.complete) {
      return { commands, complete: false };
    }
    const children = executableBodyEvents(item.text)
      .sort((a, b) => a.start - b.start)
      .map((event) => ({
        text: event.text.trim(),
        start: event.start + (event.text.length - event.text.trimStart().length),
      }))
      .filter((child) => child.text !== "" && !seen.has(child.text) && !queued.has(child.text));
    if (children.length > 0 && item.depth >= maxDepth) {
      return { commands, complete: false };
    }
    for (const body of children) {
      queued.add(body.text);
      enqueue({
        text: body.text,
        depth: item.depth + 1,
        offset: item.offset + body.start,
      });
    }
  }
  return { commands, complete: true };
}

function queueBefore(
  a: { offset: number; sequence: number },
  b: { offset: number; sequence: number },
): boolean {
  return a.offset < b.offset || (a.offset === b.offset && a.sequence <= b.sequence);
}

/**
 * Gather child executable bodies and retain their lexical position. The tree
 * itself intentionally exposes only strings, but queueing these events by
 * source offset prevents a substitution found early in a command from being
 * visited after a later function/control clause merely because the extractors
 * happen to run in a different order.
 */
function executableBodyEvents(command: string): ExecutableBodyEvent[] {
  const events: ExecutableBodyEvent[] = [];
  const substitutionBodies = substitutionBodySpans(command);
  for (const body of substitutionBodies.bodies) events.push({ text: body.text, start: body.start });

  for (const clause of inspectShellCommandClauseEvents(command).events) {
    events.push({ text: clause.text, start: clause.start });
  }
  return events;
}

/** One argv word: its unquoted value and where its source spelling sits. */
export interface ShellWord {
  value: string;
  /** Offset of the word's first source character. */
  start: number;
  /** Offset one past the word's last source character. */
  end: number;
  /** True when the outer shell expands part of it (`$`, backticks) before use. */
  dynamic: boolean;
}

export interface ShellWordLex {
  words: ShellWord[];
  /** False for an unterminated quote or a trailing lone backslash. */
  complete: boolean;
}

export interface TokenizeOptions {
  /**
   * Keep an unquoted `$(...)` or backtick substitution inside one word even
   * when its body contains whitespace. Argv inspection that must not mistake a
   * substitution's body for the outer command's arguments (Git verbs, env
   * normalization, read-only-head predicates) wants this; the clause and policy
   * matchers keep the split spelling they have always compared against.
   */
  atomicSubstitutions?: boolean;
}

/**
 * The one shell tokenizer. Removes quoting the way the shell does: single
 * quotes are literal; inside double quotes a backslash escapes only `$`,
 * backtick, `"`, `\` and newline (elsewhere it stays in the word); unquoted, a
 * backslash escapes any next character; backslash-newline is a line
 * continuation and vanishes; `$'...'` ANSI-C strings are decoded (`$'\x72m'`
 * is `rm`). A quoted empty string is a word. A trailing lone backslash is kept
 * in the value and marks the lex incomplete.
 *
 * Linear in the input length: one pass, no regex over the remainder.
 */
export function lexShellWords(text: string, options: TokenizeOptions = {}): ShellWordLex {
  const atomic = options.atomicSubstitutions === true;
  const words: ShellWord[] = [];
  let value = "";
  let start = -1;
  let dynamic = false;
  let quote: "'" | '"' | null = null;
  let substitutionDepth = 0;
  let backtick = false;
  let complete = true;
  const push = (end: number) => {
    if (start === -1) return;
    words.push({ value, start, end, dynamic });
    value = "";
    start = -1;
    dynamic = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else value += ch;
      continue;
    }
    if (ch === "\\") {
      if (text[i + 1] === "\n") {
        i++;
        continue;
      }
      if (start === -1) start = i;
      if (i + 1 >= text.length) {
        value += "\\";
        complete = false;
        continue;
      }
      const next = text[++i]!;
      if (quote === '"' && next !== "\\" && next !== "$" && next !== "`" && next !== '"' && next !== "\n") value += "\\";
      value += next;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else {
        value += ch;
        if (ch === "$" || ch === "`") dynamic = true;
      }
      continue;
    }
    if (ch === "$" && (text[i + 1] === "'" || text[i + 1] === '"') && substitutionDepth === 0 && !backtick) {
      if (start === -1) start = i;
      if (text[i + 1] === '"') {
        // `$"..."` is a locale-translated double-quoted string.
        quote = '"';
        i++;
        continue;
      }
      const decoded = decodeAnsiCString(text, i + 2);
      value += decoded.value;
      if (decoded.close === -1) {
        complete = false;
        i = text.length;
      } else {
        i = decoded.close;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      if (start === -1) start = i;
      quote = ch;
      continue;
    }
    if (atomic && ch === "$" && text[i + 1] === "(") {
      if (start === -1) start = i;
      value += "$(";
      dynamic = true;
      substitutionDepth++;
      i++;
      continue;
    }
    if (atomic && ch === "`") {
      if (start === -1) start = i;
      value += ch;
      dynamic = true;
      backtick = !backtick;
      continue;
    }
    if (substitutionDepth > 0 || backtick) {
      if (substitutionDepth > 0) {
        if (ch === "(") substitutionDepth++;
        else if (ch === ")") substitutionDepth--;
      }
      value += ch;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v" || /\s/.test(ch)) {
      push(i);
      continue;
    }
    if (start === -1) start = i;
    value += ch;
    if (ch === "$" || ch === "`") dynamic = true;
  }
  if (quote !== null) complete = false;
  push(text.length);
  return { words, complete };
}

const ANSI_C_SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
  "\\": "\\", "'": "'", '"': '"', "?": "?",
};

/**
 * Decode the body of a `$'...'` string starting at `from` (just past the
 * opening quote). Returns the decoded text and the index of the closing quote,
 * or -1 when it is unterminated. Unknown escapes keep their backslash, as bash
 * does.
 */
function decodeAnsiCString(text: string, from: number): { value: string; close: number } {
  let value = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "'") return { value, close: i };
    if (ch !== "\\" || i + 1 >= text.length) {
      value += ch;
      continue;
    }
    const next = text[i + 1]!;
    const simple = ANSI_C_SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      value += simple;
      i++;
      continue;
    }
    const numeric = /^(?:[0-7]{1,3}|x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8})/.exec(text.slice(i + 1, i + 10));
    if (numeric) {
      const digits = numeric[0];
      const code = /^[0-7]/.test(digits) ? parseInt(digits, 8) : parseInt(digits.slice(1), 16);
      value += code <= 0x10ffff ? String.fromCodePoint(code) : "";
      i += digits.length;
      continue;
    }
    if (next === "c" && i + 2 < text.length) {
      value += String.fromCharCode(text.charCodeAt(i + 2) & 0x1f);
      i += 2;
      continue;
    }
    value += "\\" + next;
    i++;
  }
  return { value, close: -1 };
}

/**
 * True when a `$'...'` string contains an escaped quote (`$'it\'s'`). The
 * tokenizer decodes it correctly, but every quote-state walker that treats
 * `$'...'` as a plain single-quoted span would see the `\'` close it and
 * disagree about where the quote ends, so classifiers fail closed on it.
 */
export function hasAnsiCEscapedQuote(text: string): boolean {
  let quote: "'" | '"' | "$'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === "$'") {
      if (ch === "\\") {
        if (text[i + 1] === "'") return true;
        i++;
      } else if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "$" && text[i + 1] === "'") {
      quote = "$'";
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
  }
  return false;
}

/**
 * Blank every `<` and `>` inside a quoted span (single, double or `$'...'`),
 * leaving all other text in place. Backslash escapes are honored, so `\'`
 * opens no span; an escaped angle outside quotes is kept (conservatively still
 * a redirect candidate).
 */
export function blankQuotedAngles(text: string): string {
  const blank = (c: string | undefined) => (c === "<" || c === ">" ? " " : c ?? "");
  let out = "";
  let quote: "'" | '"' | "$'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      out += blank(ch);
      continue;
    }
    if (quote === "$'") {
      if (ch === "\\") {
        out += ch + blank(text[i + 1]);
        i++;
        continue;
      }
      if (ch === "'") quote = null;
      out += blank(ch);
      continue;
    }
    if (ch === "\\") {
      out += ch + (quote === '"' ? blank(text[i + 1]) : text[i + 1] ?? "");
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      out += blank(ch);
      continue;
    }
    if (ch === "$" && text[i + 1] === "'") {
      quote = "$'";
      out += "$'";
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    out += ch;
  }
  return out;
}

/** Length of the longest run of non-whitespace characters. */
export function longestWordLength(text: string): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]!)) run = 0;
    else if (++run > longest) longest = run;
  }
  return longest;
}

/** Tokenize one shell segment into argv-like words, removing shell quoting. */
export function tokenizeShellWords(segment: string, options?: TokenizeOptions): string[] {
  return lexShellWords(segment, options).words.map((word) => word.value);
}

/**
 * Extract executable terminal clauses from shell-control syntax. Separators
 * and reserved words can occur between the control construct and its body
 * (`if true; then mkdir ...; fi`), so this is deliberately a recursive seam:
 * split quote-aware top-level clauses, then remove all leading reserved words
 * from each clause. Nested substitutions/groups/cases are returned separately
 * and queued by `inspectCommandSubstitutionTree`.
 */
export function extractShellCommandClauses(segment: string): string[] {
  return inspectShellCommandClauses(segment).clauses;
}

export interface ShellClauseInspection {
  clauses: string[];
  complete: boolean;
}

interface ShellClauseEvent {
  text: string;
  start: number;
  end: number;
}

interface ExecutableBodyEvent {
  text: string;
  start: number;
}

interface SpannedBody {
  text: string;
  start: number;
  end: number;
}

/** Inspect executable clauses and report control syntax that cannot be split safely. */
export function inspectShellCommandClauses(segment: string): ShellClauseInspection {
  const inspected = inspectShellCommandClauseEvents(segment);
  return {
    clauses: uniqueClauses(inspected.events.map((event) => event.text)),
    complete: inspected.complete,
  };
}

function inspectShellCommandClauseEvents(segment: string): { events: ShellClauseEvent[]; complete: boolean } {
  const groups = inspectParenthesizedBodies(segment);
  const functions = inspectFunctionDefinitions(segment);
  // Arithmetic evaluation uses the same punctuation as a subshell but does
  // not execute its contents as a command clause. Substitutions inside it are
  // still discovered independently by inspectCommandSubstitutions.
  if (/^\s*\(\(/.test(segment)) {
    return {
      events: [...functions.bodies, ...groups.bodies],
      complete: functions.complete && groups.complete,
    };
  }
  const caseClauses = extractCaseBranchBodies(segment);
  if (caseClauses !== null) {
    const hasCase = tokenizeShellWords(segment)[0] === "case";
    return {
      events: [...caseClauses.bodies, ...functions.bodies, ...groups.bodies],
      complete: caseClauses.complete && functions.complete && groups.complete &&
        (!hasCase || findUnquotedWord(segment, "in") !== -1 &&
          findUnquotedWord(segment, "esac") !== -1),
    };
  }
  const clauses: ShellClauseEvent[] = [];
  const parts = splitShellControlClauseSpans(segment);
  const exposeAllParts = parts.length > 1;
  for (const part of parts) {
    const tokens = tokenizeShellWords(part.text);
    if (tokens.length === 0) continue;
    // Newline-separated function syntax (`f ()\n{ ... }`) is split into a
    // header fragment and its body by the generic control splitter. The
    // function extractor owns that header; treating it as a command would make
    // a valid definition look like an incomplete function invocation.
    if (isFunctionHeaderPart(part.text)) continue;
    if (tokens[0] === "coproc") {
      let start = 1;
      // Bash permits `coproc NAME { commands; }` as well as `coproc commands`.
      if (tokens[start] && tokens[start] !== "{" && tokens[start + 1] === "{") start++;
      if (tokens[start] === "{") start++;
      const body = tokens.slice(start).join(" ").replace(/}\s*$/, "").trim();
      if (body) {
        clauses.push({ text: body, start: part.start, end: part.end });
      }
      continue;
    }
    if (SHELL_RESERVED_WORDS.has(tokens[0]!)) {
      // Keep the original shell quoting when removing reserved prefixes.
      // Rebuilding from tokenized words would turn a language string such as
      // `perl -eprint("unlink('x')")` into executable-looking Perl source.
      const executable = stripReservedPrefixText(part.text);
      if (executable) {
        clauses.push({ text: executable, start: part.start, end: part.end });
      }
    } else if (exposeAllParts) {
      // A compound command's ordinary parts are terminal clauses too. A
      // single ordinary part is already represented by the current tree node;
      // omitting it there is the recursion guard for direct callers.
      clauses.push(part);
    }
  }
  return {
    events: [...clauses, ...functions.bodies, ...groups.bodies],
    complete: groups.complete && functions.complete,
  };
}

function isFunctionHeaderPart(part: string): boolean {
  const text = part.trim();
  return /^[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)$/.test(text) ||
    /^function\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*\(\s*\))?$/.test(text);
}

const SHELL_RESERVED_WORDS = new Set([
  "{", "}", "(", ")", "!", "if", "then", "elif", "else", "fi",
  "while", "until", "do", "done", "for", "select", "function", "coproc",
]);

/** Extract POSIX/Bash function bodies, preserving quoted literals and groups. */
function inspectFunctionDefinitions(segment: string): { bodies: ShellClauseEvent[]; complete: boolean } {
  const bodies: ShellClauseEvent[] = [];
  let complete = true;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    // A function name starts at the first name character of an identifier
    // run: every later start in the same run reaches the same `()` (or none),
    // so re-matching there is only quadratic work on long words. Heads are
    // matched sticky at `i`, never by searching the rest of the segment.
    if (!isNameStart(segment, i)) continue;
    let braceStart = -1;
    NAMED_FUNCTION_HEAD.lastIndex = i;
    const namedHead = NAMED_FUNCTION_HEAD.exec(segment);
    if (namedHead && functionPrefixAllowed(segment, i)) {
      braceStart = findFunctionBrace(segment, i + namedHead[0].length);
      if (braceStart === -1) {
        complete = false;
        i += namedHead[0].length - 1;
        continue;
      }
    } else {
      DOCUMENTED_FUNCTION_HEAD.lastIndex = i;
      const documentedHead = DOCUMENTED_FUNCTION_HEAD.exec(segment);
      if (documentedHead && functionPrefixAllowed(segment, i)) {
        braceStart = findFunctionBrace(segment, i + documentedHead[0].length);
        if (braceStart === -1) {
          complete = false;
          i += documentedHead[0].length - 1;
          continue;
        }
      }
    }
    if (braceStart === -1) continue;
    const close = findMatchingBrace(segment, braceStart);
    if (close === -1) {
      // An unclosed body makes the whole inspection incomplete (fail closed);
      // scanning on would re-walk the same unclosed tail for every later head.
      complete = false;
      break;
    }
    const body = trimSpan(segment, braceStart + 1, close);
    if (body) bodies.push(body);
    i = close;
  }
  if (quote !== null) complete = false;
  return { bodies, complete };
}

const NAMED_FUNCTION_HEAD = /[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)/y;
const DOCUMENTED_FUNCTION_HEAD = /function\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*\(\s*\))?/y;
const FUNCTION_PREFIX_WORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "for", "select", "!", "function"]);

/** True at the first name character (`[A-Za-z_]`) of an identifier run. */
function isNameStart(segment: string, i: number): boolean {
  if (!/[A-Za-z_]/.test(segment[i]!)) return false;
  for (let j = i - 1; j >= 0; j--) {
    const ch = segment[j]!;
    if (/[A-Za-z_]/.test(ch)) return false;
    if (!/[0-9]/.test(ch)) return true;
  }
  return true;
}

/**
 * A function header may start a clause: after a separator or group
 * character, or after a lone control word (`if f() { ...; }`). Reads only the
 * one word before `start`, so it is not quadratic across many headers.
 */
function functionPrefixAllowed(segment: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && /\s/.test(segment[i]!)) i--;
  if (i < 0) return true;
  if (";\n\r|&{}()".includes(segment[i]!)) return true;
  const wordEnd = i + 1;
  while (i >= 0 && !/\s/.test(segment[i]!) && !";\n\r|&".includes(segment[i]!)) i--;
  const word = segment.slice(i + 1, wordEnd);
  while (i >= 0 && /\s/.test(segment[i]!)) i--;
  // Anything but a separator before the word means the clause prefix has
  // several words, which is never a lone control word.
  if (i >= 0 && !";\n\r|&".includes(segment[i]!)) return false;
  return FUNCTION_PREFIX_WORDS.has(word);
}

function findFunctionBrace(segment: string, from: number): number {
  let i = from;
  while (i < segment.length && /\s/.test(segment[i]!)) i++;
  return segment[i] === "{" ? i : -1;
}

function findMatchingBrace(segment: string, open: number): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = open + 1; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Remove leading shell-control words without erasing argument quoting. */
function stripReservedPrefixText(text: string): string | null {
  let current = text.trim();
  if (/^function\b/.test(current)) {
    current = current.replace(/^function\s+[A-Za-z_][A-Za-z0-9_]*(?:\s*)/, "");
  }
  for (let i = 0; i < 8; i++) {
    const next = current.replace(/^(?:(?:if|then|elif|else|fi|while|until|do|done|for|select|function|coproc)\b|[{}()!])\s*/u, "");
    if (next === current) break;
    current = next;
  }
  return current || null;
}

/** Split shell control separators without splitting quoted/nested syntax. */
function splitShellControlClauses(command: string): string[] {
  return splitShellControlClauseSpans(command).map((clause) => clause.text);
}

function splitShellControlClauseSpans(command: string): ShellClauseEvent[] {
  const clauses: ShellClauseEvent[] = [];
  let currentStart = -1;
  const pushCurrent = (end: number) => {
    if (currentStart === -1) return;
    const span = trimSpan(command, currentStart, end);
    if (span) clauses.push(span);
    currentStart = -1;
  };
  let quote: "'" | '"' | null = null;
  let parenDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\") {
      if (currentStart === -1) currentStart = i;
      i++;
      continue;
    }
    if (quote) {
      if (currentStart === -1) currentStart = i;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      if (currentStart === -1) currentStart = i;
      continue;
    }
    if (ch === "(") {
      parenDepth++;
      if (currentStart === -1) currentStart = i;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      parenDepth--;
      if (currentStart === -1) currentStart = i;
      continue;
    }
    if (ch === "{") {
      braceDepth++;
      if (currentStart === -1) currentStart = i;
      continue;
    }
    if (ch === "}" && braceDepth > 0) {
      braceDepth--;
      if (currentStart === -1) currentStart = i;
      continue;
    }
    const separator = parenDepth === 0 && braceDepth === 0 &&
      (ch === ";" || ch === "\n" || ch === "\r" || ch === "|" ||
        (ch === "&" && command[i - 1] !== ">"));
    if (separator) {
      // `;;`, `;&`, and `;;&` are case-branch terminators, not generic
      // command separators. Keep them with the case construct so its parser
      // can validate branch coverage and extract complete bodies.
      if (ch === ";" && (command[i + 1] === ";" || command[i + 1] === "&")) {
        if (currentStart === -1) currentStart = i;
        i++;
        if (command[i] === "&" && command[i + 1] === "&") i++;
        continue;
      }
      pushCurrent(i);
      if ((ch === "\r" && command[i + 1] === "\n") ||
          (ch === "&" && command[i + 1] === "&") ||
          (ch === "|" && command[i + 1] === "|")) i++;
      continue;
    }
    if (currentStart === -1) currentStart = i;
  }
  pushCurrent(command.length);
  return clauses;
}

/** Extract executable bodies from a complete `case ... in ... esac` command. */
function extractCaseBranchBodies(segment: string): { bodies: ShellClauseEvent[]; complete: boolean } | null {
  const tokens = tokenizeShellWords(segment);
  if (tokens[0] !== "case") return null;
  const start = findReservedWord(segment, "in");
  if (start === -1) return { bodies: [], complete: false };
  const bodyStart = start + 2;
  const end = findMatchingCaseEnd(segment, bodyStart);
  if (end === -1) return { bodies: [], complete: false };
  const body = segment.slice(bodyStart, bodyStart + end);
  const clauses: ShellClauseEvent[] = [];
  let cursor = 0;
  let complete = true;
  while (cursor < body.length) {
    while (cursor < body.length && /\s/.test(body[cursor]!)) cursor++;
    if (cursor >= body.length) break;

    // Every non-whitespace range must begin a pattern and end in an
    // unquoted, balanced `)`. Orphan text such as `orphan ;;` is not a
    // pattern; consume it only to continue finding later branches, while
    // retaining the fail-closed completeness result.
    const patternEnd = findCasePatternEnd(body, cursor);
    if (patternEnd === -1) {
      complete = false;
      break;
    }
    const branchStart = patternEnd + 1;
    const terminator = findCaseBranchTerminator(body, branchStart);
    if (terminator === null) {
      complete = false;
      break;
    }
    if (terminator.malformed) complete = false;
    const clause = trimSpan(body, branchStart, terminator.bodyEnd);
    if (clause) {
      clauses.push({ ...clause, start: bodyStart + clause.start, end: bodyStart + clause.end });
    }
    cursor = terminator.next;
  }
  const caseEnd = bodyStart + end + "esac".length;
  const suffix = splitShellControlClauseSpans(segment.slice(caseEnd));
  if (suffix.length > 0) clauses.push(...suffix.map((part) => ({
    ...part,
    start: part.start + caseEnd,
    end: part.end + caseEnd,
  })));
  return { bodies: clauses, complete };
}

function findCasePatternEnd(body: string, start: number): number {
  let quote: "'" | '"' | null = null;
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(" && !isFunctionHeaderOpen(body, i)) {
      depth++;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth--;
      else return i;
    }
    // A branch terminator before a pattern close proves this range is orphan
    // text, not a valid pattern. This also prevents silently skipping it.
    if (depth === 0 && ch === ";" && (body[i + 1] === ";" || body[i + 1] === "&")) return -1;
  }
  return -1;
}

function findCaseBranchTerminator(body: string, start: number): { bodyEnd: number; next: number; malformed: boolean } | null {
  let quote: "'" | '"' | null = null;
  let depth = 0;
  let nestedCases = 0;
  let malformed = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    const reserved = readReservedWord(body, i);
    if (reserved === "case") {
      nestedCases++;
      i += reserved.length - 1;
      continue;
    }
    if (reserved === "esac") {
      if (nestedCases > 0) nestedCases--;
      else malformed = true;
      i += reserved.length - 1;
      continue;
    }
    if (ch === "(" && !isFunctionHeaderOpen(body, i)) {
      depth++;
      continue;
    }
    if (ch === ")") {
      if (isFunctionHeaderClose(body, i)) continue;
      if (nestedCases > 0) continue;
      if (depth > 0) depth--;
      else malformed = true;
      continue;
    }
    if (depth !== 0 || nestedCases !== 0 || ch !== ";") continue;
    const next = body[i + 1];
    if (next !== ";" && next !== "&") continue;
    let end = i + 2;
    if (next === ";" && body[end] === "&") end++;
    return { bodyEnd: i, next: end, malformed };
  }
  return null;
}

function uniqueClauses(clauses: string[]): string[] {
  return [...new Set(clauses.map((clause) => clause.trim()).filter(Boolean))];
}

interface ParenthesizedBodyInspection {
  bodies: ShellClauseEvent[];
  complete: boolean;
}

/** Extract executable `(...)` groups, excluding quoted text, arithmetic, and substitutions. */
function inspectParenthesizedBodies(command: string): ParenthesizedBodyInspection {
  const bodies: ShellClauseEvent[] = [];
  let quote: "'" | '"' | null = null;
  let complete = true;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch !== "(") continue;
    if (command[i + 1] === "(") {
      i++;
      continue;
    }
    if (command[i - 1] === "$" || command[i - 1] === "<" || command[i - 1] === ">") continue;
    // An opening parenthesis embedded in a shell word is literal text, not a
    // subshell group (`ruby -eprint(...)`, `echo foo(bar)`).
    if (i > 0 && !/[\s;|&(){}]/.test(command[i - 1]!)) continue;
    let depth = 1;
    let innerQuote: "'" | '"' | null = null;
    let close = -1;
    for (let j = i + 1; j < command.length; j++) {
      const inner = command[j]!;
      if (inner === "\\") {
        j++;
        continue;
      }
      if (innerQuote) {
        if (inner === innerQuote) innerQuote = null;
        continue;
      }
      if (inner === "'" || inner === '"') {
        innerQuote = inner;
        continue;
      }
      if (inner === "(") depth++;
      else if (inner === ")" && --depth === 0) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      complete = false;
      continue;
    }
    const body = trimSpan(command, i + 1, close);
    if (body) bodies.push(body);
    i = close;
  }
  if (quote !== null) complete = false;
  return { bodies, complete };
}

function trimSpan(source: string, start: number, end: number): ShellClauseEvent | null {
  while (start < end && /\s/.test(source[start]!)) start++;
  while (end > start && /\s/.test(source[end - 1]!)) end--;
  return start < end ? { text: source.slice(start, end), start, end } : null;
}

function isFunctionHeaderClose(source: string, close: number): boolean {
  if (source[close] !== ")") return false;
  let i = close - 1;
  while (i >= 0 && /\s/.test(source[i]!)) i--;
  if (source[i] !== "(") return false;
  i--;
  while (i >= 0 && /\s/.test(source[i]!)) i--;
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(source[i]!)) i--;
  if (end === i + 1) return false;
  let after = close + 1;
  while (after < source.length && /\s/.test(source[after]!)) after++;
  return source[after] === "{";
}

function isFunctionHeaderOpen(source: string, open: number): boolean {
  if (source[open] !== "(") return false;
  let close = open + 1;
  while (close < source.length && /\s/.test(source[close]!)) close++;
  if (source[close] !== ")") return false;
  return isFunctionHeaderClose(source, close);
}

function findUnquotedWord(text: string, word: string): number {
  return findReservedWord(text, word);
}

/** Find a shell reserved word without requiring whitespace after it. */
function findReservedWord(text: string, word: string, from = 0): number {
  let quote: "'" | '"' | null = null;
  for (let i = from; i <= text.length - word.length; i++) {
    const ch = text[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (text.slice(i, i + word.length) === word &&
        (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]!)) &&
        (i + word.length === text.length || !/[A-Za-z0-9_]/.test(text[i + word.length]!))) return i;
  }
  return -1;
}

function readReservedWord(text: string, start: number): string | null {
  for (const word of ["case", "esac"]) {
    if (text.slice(start, start + word.length) !== word) continue;
    if (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1]!)) continue;
    const end = start + word.length;
    if (end < text.length && /[A-Za-z0-9_]/.test(text[end]!)) continue;
    return word;
  }
  return null;
}

/** Return the offset of the matching outer `esac`, counting nested cases. */
function findMatchingCaseEnd(text: string, from: number): number {
  let nested = 0;
  let quote: "'" | '"' | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    const reserved = readReservedWord(text, i);
    if (reserved === "case") {
      nested++;
      i += reserved.length - 1;
    } else if (reserved === "esac") {
      if (nested === 0) return i - from;
      nested--;
      i += reserved.length - 1;
    }
  }
  return -1;
}

function stripTokenAssignments(tokens: readonly string[]): string[] {
  let i = 0;
  while (i < tokens.length - 1 && TOKEN_ASSIGNMENT_PATTERN.test(tokens[i]!)) i++;
  return i === 0 ? [...tokens] : tokens.slice(i);
}

function optionArgument(
  wrapper: string,
  token: string,
  options: ReturnType<typeof wrapperOptions>,
): { takesArgument: boolean; attached: boolean } {
  const names = options.optionArguments.get(wrapper);
  if (!names) return { takesArgument: false, attached: false };
  for (const name of names) {
    if (token === name) return { takesArgument: true, attached: false };
    if (name.startsWith("--") && token.startsWith(`${name}=`)) {
      return { takesArgument: true, attached: true };
    }
    if (!name.startsWith("--") && token.startsWith("-") && !token.startsWith("--")) {
      const short = name.slice(1);
      const position = token.indexOf(short, 1);
      if (position !== -1) {
        return { takesArgument: true, attached: position < token.length - 1 };
      }
    }
    if (!name.startsWith("--") && token.startsWith(name) && token.length > name.length) {
      return { takesArgument: true, attached: true };
    }
  }
  return { takesArgument: false, attached: false };
}

function splitStringPayload(
  wrapper: string,
  token: string,
  options: ReturnType<typeof wrapperOptions>,
): string | null {
  const names = options.splitStringOptions.get(wrapper);
  if (!names) return null;
  for (const name of names) {
    if (token === name) return "";
    if (name.startsWith("--") && token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    if (!name.startsWith("-") || token.startsWith("--")) continue;
    const short = name.slice(1);
    const position = token.indexOf(short, 1);
    if (position !== -1 && position < token.length - 1) return token.slice(position + short.length);
  }
  return null;
}

function stripTokenWrapper(tokens: readonly string[], options: ReturnType<typeof wrapperOptions>): string[] {
  const head = tokens[0];
  const wrapper = head?.replace(/^.*\//, "");
  if (!wrapper || !(options.wrappers.has(wrapper) || options.bareOnlyWrappers.has(wrapper))) return [...tokens];
  const next = tokens[1];
  const isFlag = next !== undefined && next.startsWith("-");
  if (options.bareOnlyWrappers.has(wrapper) && isFlag) return [...tokens];
  let drop = 1;
  if (options.splitStringOptions.has(wrapper)) {
    for (let i = 1; i < tokens.length; i++) {
      const payload = splitStringPayload(wrapper, tokens[i]!, options);
      if (payload !== null) {
        if (payload !== "") return tokenizeShellWords(payload);
        return i + 1 < tokens.length ? tokenizeShellWords(tokens[i + 1]!) : [...tokens];
      }
    }
  }
  if (options.optionTakingWrappers.has(wrapper) || options.optionArguments.has(wrapper)) {
    while (drop < tokens.length) {
      const token = tokens[drop]!;
      const argument = optionArgument(wrapper, token, options);
      if (argument.takesArgument) {
        drop++;
        if (!argument.attached && drop < tokens.length) drop++;
        continue;
      }
      if (token.startsWith("-") || options.durationPattern.test(token)) drop++;
      else break;
    }
  }
  return drop >= tokens.length ? [...tokens] : tokens.slice(drop);
}

function stripRaw(command: string, options: ReturnType<typeof wrapperOptions>): string {
  let cmd = command.trim();
  for (let pass = 0; pass < 16; pass++) {
    const before = cmd;
    const spans = lexShellWords(cmd).words;
    const tokens = spans.map((span) => span.value);
    const assignmentCount = (() => {
      let i = 0;
      while (i < tokens.length - 1 && TOKEN_ASSIGNMENT_PATTERN.test(tokens[i]!)) i++;
      return i;
    })();
    if (assignmentCount > 0) {
      cmd = cmd.slice(spans[assignmentCount]!.start).trimStart();
      continue;
    }
    const head = tokens[0];
    const wrapper = head?.replace(/^.*\//, "");
    if (wrapper && (options.wrappers.has(wrapper) || options.bareOnlyWrappers.has(wrapper))) {
      const next = tokens[1];
      const isFlag = next !== undefined && next.startsWith("-");
      if (!(options.bareOnlyWrappers.has(wrapper) && isFlag)) {
        if (options.splitStringOptions.has(wrapper)) {
          const lexicalTokens = tokenizeShellWords(cmd);
          for (let i = 1; i < lexicalTokens.length; i++) {
            const payload = splitStringPayload(wrapper, lexicalTokens[i]!, options);
            if (payload !== null) {
              const source = payload || lexicalTokens[i + 1];
              return source === undefined ? cmd : stripRaw(source, options);
            }
          }
        }
        let drop = 1;
        if (options.optionTakingWrappers.has(wrapper) || options.optionArguments.has(wrapper)) {
          while (drop < tokens.length) {
            const token = tokens[drop]!;
            const argument = optionArgument(wrapper, token, options);
            if (argument.takesArgument) {
              drop++;
              if (!argument.attached && drop < tokens.length) drop++;
              continue;
            }
            if (token.startsWith("-") || options.durationPattern.test(token)) drop++;
            else break;
          }
        }
        if (drop < spans.length) cmd = cmd.slice(spans[drop]!.start).trimStart();
      }
    }
    if (cmd === before) break;
  }
  return cmd;
}

/**
 * Strip leading assignments and wrappers. String input preserves the original
 * quote spelling for host glob matching; token input is useful for argv-style
 * prefix matching (Codex).
 */
export function stripLeadingAssignmentsAndWrappers(command: string, options?: WrapperInspectionOptions): string;
export function stripLeadingAssignmentsAndWrappers(tokens: readonly string[], options?: WrapperInspectionOptions): string[];
export function stripLeadingAssignmentsAndWrappers(
  input: string | readonly string[],
  options?: WrapperInspectionOptions,
): string | string[] {
  const resolved = wrapperOptions(options);
  if (typeof input === "string") return stripRaw(input, resolved);
  let current = [...input];
  for (let pass = 0; pass < 16; pass++) {
    const before = current;
    current = stripTokenAssignments(current);
    current = stripTokenWrapper(current, resolved);
    if (current.length === before.length && current.every((token, i) => token === before[i])) break;
  }
  return current;
}

/**
 * Blank here-document bodies (keeping line breaks) so their text is data, not
 * command clauses: a literal `>` or `;` in a heredoc is not shell syntax.
 */
export function maskHeredocBodies(cmd: string): string {
  const chars = cmd.split("");
  const ranges: Array<[number, number]> = [];
  const pending: Array<{ delimiter: string; stripTabs: boolean; bodyStart: number }> = [];
  let quote: "'" | '"' | null = null;
  let lineStart = 0;
  while (lineStart < cmd.length) {
    const newline = cmd.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? cmd.length : newline;
    if (pending.length > 0) {
      const candidate = cmd.slice(lineStart, lineEnd).replace(/\r$/, "");
      const expected = pending[0]!;
      const comparable = expected.stripTabs ? candidate.replace(/^\t+/, "") : candidate;
      if (comparable === expected.delimiter) {
        ranges.push([expected.bodyStart, newline < 0 ? lineEnd : newline + 1]);
        pending.shift();
        if (pending.length > 0) pending[0]!.bodyStart = newline < 0 ? lineEnd : newline + 1;
      }
      lineStart = newline < 0 ? cmd.length : newline + 1;
      continue;
    }
    for (let i = lineStart; i < lineEnd; i++) {
      const ch = cmd[i]!;
      if (ch === "\\" && quote !== "'") { i++; continue; }
      if (quote !== null) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch !== "<" || cmd[i + 1] !== "<" || cmd[i + 2] === "<") continue;
      let cursor = i + 2;
      let stripTabs = false;
      if (cmd[cursor] === "-") { stripTabs = true; cursor++; }
      while (cursor < lineEnd && /[ \t]/.test(cmd[cursor]!)) cursor++;
      let delimiter = "";
      const delimiterQuote = cmd[cursor] === "'" || cmd[cursor] === '"' ? cmd[cursor++] : null;
      while (cursor < lineEnd) {
        const next = cmd[cursor]!;
        if (delimiterQuote !== null) {
          if (next === delimiterQuote) { cursor++; break; }
          delimiter += next;
        } else if (/[A-Za-z0-9_]/.test(next)) delimiter += next;
        else break;
        cursor++;
      }
      if (delimiter.length > 0) pending.push({ delimiter, stripTabs, bodyStart: lineEnd + (newline < 0 ? 0 : 1) });
      i = Math.max(i, cursor - 1);
    }
    lineStart = newline < 0 ? cmd.length : newline + 1;
  }
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  }
  return chars.join("");
}

/**
 * Split a compound command into pipeline segments on unquoted `|`, `;`, `&&`,
 * `||`, newlines, and bare `&` (but not `>&`/`&&` fd-dup/joins). Backslash
 * escapes outside single quotes are honored: `\;` is an argument, and `\"`
 * opens no quoted span (CORE-7). Exception-safe: any confusion degrades to the
 * whole command as one segment.
 */
export function splitCommandSegments(cmd: string): string[] {
  try {
    const shellCommand = maskHeredocBodies(cmd);
    const segments: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < shellCommand.length; i++) {
      const ch = shellCommand[i]!;
      if (ch === "\\" && !inSingle) {
        current += ch + (shellCommand[i + 1] ?? "");
        i++;
        continue;
      }
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      if (!inSingle && !inDouble && (ch === "|" || ch === ";" || ch === "&" || ch === "\n" || ch === "\r")) {
        // `2>&1` / `>&2`: an & directly after `>` is an fd dup, not a join.
        if (ch === "&" && shellCommand[i - 1] === ">") {
          current += ch;
          continue;
        }
        if (current.trim()) segments.push(current.trim());
        current = "";
        // swallow the second char of `&&` / `||`
        if (shellCommand[i + 1] === ch) i++;
        // Treat CRLF as one command separator.
        if (ch === "\r" && shellCommand[i + 1] === "\n") i++;
        continue;
      }
      current += ch;
    }
    if (current.trim()) segments.push(current.trim());
    return segments.length > 0 ? segments : [shellCommand];
  } catch {
    return [cmd];
  }
}

/** Bodies of executable `(...)` groups (not substitutions or arithmetic). */
export function parenthesizedBodies(command: string): string[] {
  return inspectParenthesizedBodies(command).bodies.map((body) => body.text);
}

/**
 * Wrapper commands that defer to the next token. `env` belongs here, not in
 * READ_ONLY_HEADS: bare `env` prints the environment, but `env rm -rf /` runs
 * rm. Treating it as a pure reader skipped the word scan entirely and let every
 * `env <writer>` through. As a wrapper, `env FOO=1 rm …` resolves to `rm` (the
 * VAR=val skip in effectiveHead already handles the assignment), and a bare
 * `env` falls through to the word scan, which is the safe direction.
 */
export const WRAPPERS: ReadonlySet<string> = new Set([
  "time", "nice", "nohup", "command", "builtin", "xargs", "env", "timeout", "stdbuf", "noglob",
]);

/** Wrappers that take one positional argument (a duration) before the command. */
export const WRAPPER_DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/;
export const WRAPPERS_WITH_DURATION: ReadonlySet<string> = new Set(["timeout"]);

/** Wrapper flags whose next token is a flag value rather than the command. */
export const WRAPPER_OPTIONS_WITH_VALUE: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  nice: new Set(["-n", "--adjustment"]),
  xargs: new Set([
    "-E", "-I", "-L", "-n", "-P", "-s", "-a", "--eof", "--end-of-file", "--replace",
    "--max-lines", "--max-procs", "--max-chars", "--arg-file",
  ]),
  command: new Set(),
  builtin: new Set(),
  time: new Set(["-f", "--format", "-o", "--output"]),
  nohup: new Set(),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
  noglob: new Set(),
};

export function wrapperOptionHasAttachedValue(wrapper: string, option: string): boolean {
  if (wrapper === "env") {
    return /^-(?:u|C|S).+/.test(option) || /^(?:--unset|--chdir|--split-string)=/.test(option);
  }
  if (wrapper === "nice") return /^-n.+/.test(option) || /^--adjustment=/.test(option);
  if (wrapper === "xargs") {
    return /^-[EILnPsa].+/.test(option) || /^(?:--eof|--end-of-file|--replace|--max-lines|--max-procs|--max-chars|--arg-file)=/.test(option);
  }
  if (wrapper === "time") return /^(?:--format|--output)=/.test(option);
  if (wrapper === "timeout") return /^-[sk].+/.test(option) || /^(?:--signal|--kill-after)=/.test(option);
  if (wrapper === "stdbuf") return /^-[ioe].+/.test(option) || /^(?:--input|--output|--error)=/.test(option);
  return false;
}

/** Core's wrapper vocabulary as `stripLeadingAssignmentsAndWrappers` defaults. */
const DEFAULT_STRIP_WRAPPERS: ReadonlySet<string> =
  new Set([...WRAPPERS].filter((wrapper) => !DEFAULT_BARE_ONLY_WRAPPERS.has(wrapper)));
const DEFAULT_OPTION_TAKING_WRAPPERS: ReadonlySet<string> = new Set(
  [...DEFAULT_STRIP_WRAPPERS].filter((wrapper) =>
    (WRAPPER_OPTIONS_WITH_VALUE[wrapper]?.size ?? 0) > 0 || WRAPPERS_WITH_DURATION.has(wrapper)),
);
const DEFAULT_SPLIT_STRING_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> =
  new Map([["env", new Set(["-S", "--split-string"])]]);
const DEFAULT_OPTION_ARGUMENTS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  [...DEFAULT_OPTION_TAKING_WRAPPERS].map((wrapper) => [
    wrapper,
    new Set([...(WRAPPER_OPTIONS_WITH_VALUE[wrapper] ?? [])]
      .filter((option) => !DEFAULT_SPLIT_STRING_OPTIONS.get(wrapper)?.has(option))),
  ]),
);

export interface EnvOption {
  takesArgument: boolean;
  attached: boolean;
  splitPayload?: string;
  known: boolean;
}

/** Parse env's short clusters without mistaking an option value for a command. */
export function envOption(token: string): EnvOption {
  if (token === "--ignore-environment") return { takesArgument: false, attached: false, known: true };
  if (token === "--null" || token === "--debug") return { takesArgument: false, attached: false, known: true };
  for (const name of ["--unset", "--chdir", "--argv0"]) {
    if (token === name) return { takesArgument: true, attached: false, known: true };
    if (token.startsWith(`${name}=`)) return { takesArgument: true, attached: true, known: true };
  }
  if (token === "--split-string") return { takesArgument: true, attached: false, splitPayload: "", known: true };
  if (token.startsWith("--split-string=")) return {
    takesArgument: true,
    attached: true,
    splitPayload: token.slice("--split-string=".length),
    known: true,
  };
  if (token === "-i" || token === "-0" || token === "-v") return { takesArgument: false, attached: false, known: true };
  if (!token.startsWith("-") || token.startsWith("--")) return { takesArgument: false, attached: false, known: false };
  const flags = token.slice(1);
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (flag === "i" || flag === "0" || flag === "v") continue;
    if (flag !== "u" && flag !== "C" && flag !== "S" && flag !== "P") return { takesArgument: false, attached: false, known: false };
    const rest = flags.slice(i + 1);
    return {
      takesArgument: true,
      attached: rest.length > 0,
      ...(flag === "S" ? { splitPayload: rest } : {}),
      known: true,
    };
  }
  return { takesArgument: false, attached: false, known: true };
}

/**
 * An assignment word, with the same grammar as TOKEN_ASSIGNMENT_PATTERN.
 * Groups: 1 the bare variable name (subscript and `+` stripped), 2 the value.
 * Use `isAppendAssignment` to tell `NAME+=v` (value appended to an unknown
 * current value) from `NAME=v`.
 */
export const ENV_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=(.*)$/s;

/** True for `NAME+=...` / `NAME[i]+=...`: the resulting value is not just the text given. */
export function isAppendAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+=/.test(token);
}

export interface EnvInvocationNormalization {
  argv: string[];
  assignments: string[];
  envSeen: boolean;
  complete: boolean;
}

const ENV_MAX_DEPTH = 8;
const ENV_MAX_ARGV = 256;
const ENV_MAX_CHARS = 64 * 1024;

function incompleteEnvNormalization(): EnvInvocationNormalization {
  return { argv: [], assignments: [], envSeen: true, complete: false };
}

/**
 * Resolve the effective executable of an argv: skip leading `NAME=value`
 * assignments and core `WRAPPERS` (with their options, durations and nested
 * `env -S` payloads), collecting the assignments the command inherits.
 * Bounded; anything it cannot place is `complete: false`.
 */
export function normalizeEnvInvocation(tokens: readonly string[], depth = 0, inherited: string[] = []): EnvInvocationNormalization {
  if (depth > ENV_MAX_DEPTH || tokens.length > ENV_MAX_ARGV || tokens.join(" ").length > ENV_MAX_CHARS) {
    return incompleteEnvNormalization();
  }
  const assignments = [...inherited];
  let index = 0;
  let envSeen = false;
  const consumeAssignments = () => {
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (ENV_ASSIGNMENT_RE.test(token)) { assignments.push(token); index++; continue; }
      // The argv tokenizer keeps a trailing command separator attached to an
      // assignment (`x=1; [[ ... ]]`). It is still an assignment prefix for
      // head resolution; retaining the token keeps Git-name matching strict.
      if (/^[A-Za-z_][A-Za-z0-9_]*=[^;|&(){}[\]]+[;|&(){}[\]]/.test(token)) {
        assignments.push(token);
        index++;
      }
      break;
    }
  };
  const consumeWrapperOptions = (wrapper: string): boolean => {
    while (index < tokens.length && tokens[index]!.startsWith("-")) {
      const option = tokens[index]!;
      if (option === "--") { index++; return true; }
      const optionSet = WRAPPER_OPTIONS_WITH_VALUE[wrapper];
      if (optionSet?.has(option) && !wrapperOptionHasAttachedValue(wrapper, option)) {
        if (++index >= tokens.length) return false;
      }
      index++;
    }
    return true;
  };

  consumeAssignments();

  while (index < tokens.length) {
    const base = tokens[index]!.replace(/^.*\//, "");
    if (base !== "env") {
      // An `=` in the head position that is not an assignment (those were
      // consumed above) leaves the command unknowable. Only the text before
      // the `=` decides: a value may hold any character (`X+='|x'`), while
      // shell syntax in the name part (`(a=b`) is not an assignment at all.
      const head = tokens[index]!;
      const equals = head.indexOf("=");
      if (equals !== -1 && !/[;|&(){}]/.test(head.slice(0, equals))) return incompleteEnvNormalization();
      if (!WRAPPERS.has(base)) return { argv: tokens.slice(index), assignments, envSeen, complete: true };
      index++;
      if (!consumeWrapperOptions(base)) return incompleteEnvNormalization();
      if (WRAPPERS_WITH_DURATION.has(base)) {
        // `timeout DURATION CMD`: a missing or malformed duration leaves the
        // command position unknown, so fail closed rather than guess.
        if (index >= tokens.length) return { argv: [], assignments, envSeen, complete: true };
        if (!WRAPPER_DURATION_RE.test(tokens[index]!)) return incompleteEnvNormalization();
        index++;
      }
      consumeAssignments();
      continue;
    }

    envSeen = true;
    index++;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (ENV_ASSIGNMENT_RE.test(token)) { assignments.push(token); index++; continue; }
      if (token === "--") { index++; break; }
      if (!token.startsWith("-")) break;
      const option = envOption(token);
      if (!option.known) return incompleteEnvNormalization();
      if (option.splitPayload !== undefined) {
        let payload = option.splitPayload;
        if (!option.attached) {
          if (++index >= tokens.length) return incompleteEnvNormalization();
          payload = tokens[index]!;
        }
        if (payload.length > ENV_MAX_CHARS) return incompleteEnvNormalization();
        const parsed = lexShellWords(payload);
        if (!parsed.complete || parsed.words.some((word) => word.dynamic)) return incompleteEnvNormalization();
        const composed = parsed.words.map((word) => word.value).concat(tokens.slice(index + 1));
        if (composed.length > ENV_MAX_ARGV || composed.join(" ").length > ENV_MAX_CHARS) return incompleteEnvNormalization();
        const nested = normalizeEnvInvocation(composed, depth + 1, assignments);
        return { ...nested, envSeen: true };
      }
      if (option.takesArgument && !option.attached) {
        if (++index >= tokens.length) return incompleteEnvNormalization();
      }
      index++;
    }
    consumeAssignments();
    if (index >= tokens.length) return { argv: [], assignments, envSeen, complete: true };
  }
  return { argv: [], assignments, envSeen, complete: true };
}

/** The basename of a segment's effective executable, or null when unknowable. */
export function effectiveHead(segment: string): string | null {
  const normalized = normalizeEnvInvocation(tokenizeShellWords(segment, { atomicSubstitutions: true }));
  if (!normalized.complete || normalized.argv.length === 0) return null;
  const base = normalized.argv[0]!.replace(/^.*\//, "");
  return base || null;
}
