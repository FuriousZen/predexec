/**
 * predexec core — arithmetic over data-derived variables (E-A).
 *
 * PURE TS, imports nothing outside core/. In an arithmetic context bash
 * evaluates a variable's VALUE as an expression, and an array subscript inside
 * that value runs command substitutions: `c='a[$(id)]'; echo $((c))` runs `id`.
 * Within one command, a value can only become attacker-controlled through data:
 * `$(…)`/backticks, `read`, `mapfile`/`readarray`, `printf -v`, a `for`/`select`
 * over a non-literal list, `getopts`, or a copy of another such variable. This
 * module tracks those names and reports one referenced in an arithmetic
 * context: `$((…))`, `((…))`, `$[…]`, `let`, the operands of `[[ … -eq … ]]`
 * and its siblings, array subscripts, `${var:off:len}`, and integer-declared
 * (`declare -i`) assignments.
 *
 * The same evaluation happens when a data-derived value is used as a variable
 * NAME: bash parses the name, and a subscript in it runs. Measured on bash 3.2
 * and macOS /bin/sh with c='a[$(echo PWNED >&2)]', these evaluate: `${!c}`
 * (any operator form except the `${!c[@]}` key list), `[[ -v $c ]]`,
 * `printf -v "$c"`, `read "$c"` (and `-a`), `getopts o "$c"`,
 * `declare|typeset|local|export|readonly "$c=…"`, bare `export|readonly "$c"`,
 * `declare -p "$c"`, and (sh only) `unset -f "$c"`. These do not: namerefs
 * (`declare -n`, bash >= 4.3 only), `test -v`/`[ -v`, plain `unset "$c"`, and
 * bare `declare|local "$c"`.
 *
 * The analysis is deliberately flow-insensitive and over-approximating: order
 * is ignored, quoting is ignored for context detection, and any identifier in
 * an assignment value counts as a dependency (bash re-evaluates a bare name's
 * value too: `d=c; echo $((d))` evaluates `c`). Every approximation errs toward
 * "tainted". When a context cannot be delimited, it falls back to treating any
 * identifier in any arithmetic context as tainted, provided the command
 * contains a data-assignment construct at all.
 *
 * Linear in the command's size (the substitution tree it walks is bounded by
 * inspectCommandSubstitutionTree's own budgets): one bracket-matching pass,
 * one coverage pass for arithmetic ranges, one word pass per tree body.
 */

import {
  ARGV,
  ENV_ASSIGNMENT_RE,
  inspectCommandSubstitutions,
  inspectCommandSubstitutionTree,
  lexShellWords,
  splitCommandSegments,
  type ShellWord,
} from "./lexer.ts";

const IDENTIFIER_RE = /(?<![0-9A-Za-z_#])[A-Za-z_][A-Za-z0-9_]*/g;
const IDENTIFIER_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ARITHMETIC_TEST_OPERATORS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const DECLARE_HEADS = new Set(["declare", "typeset", "local", "export", "readonly"]);
/** `$name` / `${name…}` references in a word's raw text. */
const VARIABLE_REFERENCE_RE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
/** `read` options whose next word is not a variable name. */
const READ_VALUE_OPTIONS = new Set(["-p", "-d", "-i", "-n", "-N", "-t", "-u"]);
const COMMAND_PREFIX_WORDS = new Set(["command", "builtin"]);
/** Control-syntax prefixes; `for`/`select` stay, their loop variable is a source. */
const CONTROL_PREFIX_RE = /^(?:(?:if|then|elif|else|fi|while|until|do|done|function|coproc|time)(?=\s|$)|[!{}()])\s*/;
/** A word that starts a redirection ends a `read`/`mapfile` name list. */
const REDIRECTION_WORD_RE = /^[0-9]*[<>&]/;
/** Any data-assignment construct, for the fallback when a context cannot be delimited. */
const DATA_CONSTRUCT_RE = /\$\(|`|\b(?:read|mapfile|readarray|getopts|printf|for|select)\b/;

function identifiers(text: string): string[] {
  return text.match(IDENTIFIER_RE) ?? [];
}

function variableReferences(text: string): string[] {
  return [...text.matchAll(VARIABLE_REFERENCE_RE)].map((m) => m[1]!);
}

/**
 * Pair every `(`/`[`/`{` with its closer in one pass, quote-unaware. Unmatched
 * closers are ignored; unmatched openers have no entry.
 */
function matchBrackets(text: string): Int32Array {
  const match = new Int32Array(text.length).fill(-1);
  const stacks: Record<string, number[]> = { "(": [], "[": [], "{": [] };
  const openerOf: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[" || ch === "{") stacks[ch]!.push(i);
    else if (ch === ")" || ch === "]" || ch === "}") {
      const open = stacks[openerOf[ch]!]!.pop();
      if (open !== undefined) {
        match[open] = i;
        match[i] = open;
      }
    }
  }
  return match;
}

interface ArithmeticRanges {
  identifiers: string[];
  /** Variables whose values the raw text uses as a name: `${!c}`, `[[ -v $c ]]`. */
  nameReferences: string[];
  complete: boolean;
}

/**
 * Identifiers the raw text references inside `$((…))`, `((…))`, `$[…]`,
 * `[[ … -eq … ]]` operands, `NAME[…]` subscripts and `${var:off:len}`.
 */
function arithmeticRangeIdentifiers(text: string): ArithmeticRanges {
  const match = matchBrackets(text);
  // Difference array over covered positions keeps nested contexts linear.
  const cover = new Int32Array(text.length + 1);
  let complete = true;
  const nameReferences: string[] = [];
  const mark = (start: number, end: number) => {
    if (start >= end) return;
    cover[start]!++;
    cover[end]!--;
  };
  const markOpen = (open: number, bodyStart: number) => {
    const close = match[open]!;
    if (close === -1 || close < open) {
      complete = false;
      mark(bodyStart, text.length);
      return -1;
    }
    mark(bodyStart, close);
    return close;
  };
  let testEnd = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    const previous = i > 0 ? text[i - 1]! : "";
    if (ch === "(" && next === "(") {
      markOpen(i, i + 2);
    } else if (ch === "$" && next === "[") {
      markOpen(i + 1, i + 2);
    } else if (ch === "$" && next === "{") {
      const close = match[i + 1]!;
      if (close === -1 || close < i + 1) {
        complete = false;
        mark(i + 2, text.length);
        continue;
      }
      // `${[#!]NAME[sub]:off:len}`: the offset and length are arithmetic.
      let cursor = i + 2;
      const indirect = text[cursor] === "!";
      if (text[cursor] === "#" || indirect) cursor++;
      const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*])/.exec(text.slice(cursor, Math.min(close, cursor + 256)));
      if (!name) continue;
      cursor += name[0].length;
      // `${!c…}` expands the variable NAMED by c's value, except the key list
      // `${!c[@]}` and the name-prefix lists `${!c*}` / `${!c@}`.
      if (indirect && !/^(?:\[[@*]\]\}|[@*]\})/.test(text.slice(cursor, cursor + 4))) nameReferences.push(name[0]);
      if (text[cursor] === "[") {
        const subscriptClose = match[cursor]!;
        if (subscriptClose === -1 || subscriptClose > close) continue;
        cursor = subscriptClose + 1;
      }
      if (text[cursor] === ":" && !/[-=?+]/.test(text[cursor + 1] ?? "")) mark(cursor + 1, close);
    } else if (ch === "[" && /[A-Za-z0-9_]/.test(previous)) {
      markOpen(i, i + 1);
    } else if (ch === "[" && next === "[" && i > testEnd) {
      const close = match[i]!;
      const bodyEnd = close === -1 || close < i ? text.length : close - 1;
      if (bodyEnd === text.length) complete = false;
      testEnd = bodyEnd;
      markTestOperands(text, i + 2, bodyEnd, mark, nameReferences);
    }
  }
  const covered: string[] = [];
  let depth = 0;
  let runStart = -1;
  for (let i = 0; i <= text.length; i++) {
    depth += cover[i]!;
    const inside = depth > 0 && i < text.length;
    if (inside && runStart === -1) runStart = i;
    if (!inside && runStart !== -1) {
      covered.push(text.slice(runStart, i));
      runStart = -1;
    }
  }
  return { identifiers: covered.flatMap(identifiers), nameReferences, complete };
}

/**
 * Mark the words on either side of each arithmetic comparison in a `[[ … ]]`
 * body, and record the variables a `-v` operand names.
 */
function markTestOperands(
  text: string,
  start: number,
  end: number,
  mark: (start: number, end: number) => void,
  nameReferences: string[],
): void {
  const words: Array<[number, number]> = [];
  let wordStart = -1;
  for (let i = start; i <= end; i++) {
    const blank = i === end || /\s/.test(text[i]!);
    if (!blank && wordStart === -1) wordStart = i;
    if (blank && wordStart !== -1) {
      words.push([wordStart, i]);
      wordStart = -1;
    }
  }
  for (let w = 0; w < words.length; w++) {
    const [s, e] = words[w]!;
    const word = text.slice(s, e);
    if (word === "-v" && w + 1 < words.length) {
      nameReferences.push(...variableReferences(text.slice(words[w + 1]![0], words[w + 1]![1])));
    }
    if (!ARITHMETIC_TEST_OPERATORS.has(word)) continue;
    if (w > 0) mark(words[w - 1]![0], words[w - 1]![1]);
    if (w + 1 < words.length) mark(words[w + 1]![0], words[w + 1]![1]);
  }
}

interface Flow {
  /** Names assigned from data. */
  sources: Set<string>;
  /** name -> names whose values flow into it. */
  dependencies: Map<string, Set<string>>;
  /** Identifiers referenced in word-level arithmetic contexts (`let`, `declare -i`). */
  arithmetic: string[];
  /** Names declared integer; their assignments are arithmetic contexts. */
  integerNames: Set<string>;
  /** Variables whose values a builtin takes as a variable name (`printf -v "$c"`). */
  nameReferences: string[];
  /** Every assignment's name and value identifiers, for the integer pass. */
  assignments: Array<{ name: string; values: string[] }>;
  complete: boolean;
}

function addDependency(flow: Flow, name: string, from: string): void {
  let set = flow.dependencies.get(name);
  if (!set) flow.dependencies.set(name, (set = new Set()));
  set.add(from);
}

/** Record `NAME=value` (and `NAME=( … )` through the rest of the segment). */
function recordAssignment(flow: Flow, segment: string, word: ShellWord, intDeclared: boolean): boolean {
  const assignment = ENV_ASSIGNMENT_RE.exec(word.value);
  if (!assignment) return false;
  const name = assignment[1]!;
  const raw = segment.slice(word.start, word.end);
  const equals = raw.indexOf("=");
  const value = raw.slice(equals + 1);
  const rawValue = value.startsWith("(") ? segment.slice(word.start + equals + 1) : value;
  const substitutions = inspectCommandSubstitutions(rawValue);
  if (!substitutions.complete || substitutions.bodies.length > 0) flow.sources.add(name);
  const values = identifiers(rawValue);
  for (const from of values) addDependency(flow, name, from);
  flow.assignments.push({ name, values });
  if (intDeclared) {
    flow.integerNames.add(name);
    flow.arithmetic.push(...values);
  }
  return true;
}

function taintIdentifierWords(flow: Flow, words: readonly ShellWord[]): void {
  for (const word of words) {
    if (REDIRECTION_WORD_RE.test(word.value)) break;
    if (IDENTIFIER_WORD_RE.test(word.value)) flow.sources.add(word.value);
    // `-aNAME` / `-vNAME`: an attached array or variable name.
    const attached = /^-[A-Za-z]*[av]([A-Za-z_][A-Za-z0-9_]*)$/.exec(word.value);
    if (attached) flow.sources.add(attached[1]!);
  }
}

/** Collect sources, dependencies and word-level arithmetic from one segment. */
function scanSegment(flow: Flow, rawSegment: string): void {
  let segment = rawSegment.trim();
  for (let i = 0; i < 8; i++) {
    const stripped = segment.replace(CONTROL_PREFIX_RE, "");
    if (stripped === segment) break;
    segment = stripped;
  }
  const lex = lexShellWords(segment, ARGV);
  if (!lex.complete) flow.complete = false;
  const words = lex.words;
  let head = 0;
  while (head < words.length && (ENV_ASSIGNMENT_RE.test(words[head]!.value) || COMMAND_PREFIX_WORDS.has(words[head]!.value))) {
    head++;
  }
  const command = words[head]?.value ?? "";
  const args = words.slice(head + 1);
  const declaresInteger = DECLARE_HEADS.has(command) &&
    args.some((word) => /^-[A-Za-z]*i/.test(word.value));
  for (const word of words) {
    if (recordAssignment(flow, segment, word, declaresInteger)) continue;
    if (declaresInteger && IDENTIFIER_WORD_RE.test(word.value) && word !== words[head]) {
      flow.integerNames.add(word.value);
    }
  }
  recordNameOperands(flow, segment, command, args);
  switch (command) {
    case "read":
    case "mapfile":
    case "readarray":
    case "getopts":
      taintIdentifierWords(flow, args);
      flow.sources.add(command === "read" ? "REPLY" : command === "getopts" ? "OPTARG" : "MAPFILE");
      break;
    case "printf":
      for (let i = 0; i < args.length; i++) {
        const value = args[i]!.value;
        if (value === "-v" && args[i + 1]) flow.sources.add(args[i + 1]!.value);
        const attached = /^-v([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
        if (attached) flow.sources.add(attached[1]!);
      }
      break;
    case "for":
    case "select": {
      const name = args[0]?.value ?? "";
      if (!IDENTIFIER_WORD_RE.test(name)) break;
      if (args[1]?.value !== "in") {
        // No list: the positional parameters, which are data.
        flow.sources.add(name);
        break;
      }
      const list = args.slice(2);
      if (list.some((word) => word.dynamic || /[*?[]/.test(word.value))) flow.sources.add(name);
      if (command === "select") flow.sources.add("REPLY");
      break;
    }
    case "let":
      for (const word of args) flow.arithmetic.push(...identifiers(word.value));
      break;
  }
}

const rawWord = (segment: string, word: ShellWord) => segment.slice(word.start, word.end);

/** Record the variables whose values `command` would use as variable names. */
function recordNameOperands(flow: Flow, segment: string, command: string, args: readonly ShellWord[]): void {
  const name = (word: ShellWord | undefined) => {
    if (word) flow.nameReferences.push(...variableReferences(rawWord(segment, word)));
  };
  const options = args.filter((word) => /^[-+]/.test(word.value)).map((word) => word.value);
  switch (command) {
    case "read":
      for (let i = 0; i < args.length; i++) {
        const value = args[i]!.value;
        if (REDIRECTION_WORD_RE.test(value)) break;
        if (READ_VALUE_OPTIONS.has(value)) i++;
        else if (!value.startsWith("-") || value === "-a") name(value === "-a" ? args[++i] : args[i]);
      }
      break;
    case "printf":
      for (let i = 0; i < args.length; i++) if (args[i]!.value === "-v") name(args[i + 1]);
      break;
    case "getopts":
      name(args[1]);
      break;
    case "unset":
      if (options.some((option) => /^-[A-Za-z]*f/.test(option))) args.forEach(name);
      break;
    case "declare":
    case "typeset":
    case "local":
    case "export":
    case "readonly": {
      // A bare name is only parsed as one by export/readonly and `-p`.
      const bareIsName = command === "export" || command === "readonly" ||
        options.some((option) => /^-[A-Za-z]*p/.test(option));
      for (const word of args) {
        if (/^[-+]/.test(word.value)) continue;
        const raw = rawWord(segment, word);
        const equals = raw.indexOf("=");
        if (equals !== -1) flow.nameReferences.push(...variableReferences(raw.slice(0, equals)));
        else if (bareIsName) flow.nameReferences.push(...variableReferences(raw));
      }
      break;
    }
  }
}

function taintedNames(flow: Flow): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const [name, froms] of flow.dependencies) {
    for (const from of froms) {
      let list = dependents.get(from);
      if (!list) dependents.set(from, (list = []));
      list.push(name);
    }
  }
  const tainted = new Set(flow.sources);
  const queue = [...flow.sources];
  while (queue.length > 0) {
    for (const next of dependents.get(queue.pop()!) ?? []) {
      if (tainted.has(next)) continue;
      tainted.add(next);
      queue.push(next);
    }
  }
  return tainted;
}

/**
 * The reason a command evaluates a data-derived variable's value, e.g.
 * `"arithmetic over data-derived variable c"` or
 * `"data-derived variable c used as a variable name"`, or null when it does not.
 */
export function findTaintedArithmetic(command: string): string | null {
  const ranges = arithmeticRangeIdentifiers(command);
  const flow: Flow = {
    sources: new Set(),
    dependencies: new Map(),
    arithmetic: [],
    integerNames: new Set(),
    nameReferences: [],
    assignments: [],
    complete: ranges.complete,
  };
  const tree = inspectCommandSubstitutionTree(command);
  if (!tree.complete) flow.complete = false;
  for (const body of tree.commands) {
    for (const segment of splitCommandSegments(body)) scanSegment(flow, segment);
  }
  for (const { name, values } of flow.assignments) {
    if (flow.integerNames.has(name)) flow.arithmetic.push(...values);
  }
  const referenced = [...ranges.identifiers, ...flow.arithmetic];
  const names = [...ranges.nameReferences, ...flow.nameReferences];
  if (referenced.length === 0 && names.length === 0) return null;
  const tainted = taintedNames(flow);
  // Unparsed: any reference counts once the command reads data at all.
  const unparsed = !flow.complete && (flow.sources.size > 0 || DATA_CONSTRUCT_RE.test(command));
  const arithmetic = referenced.find((name) => tainted.has(name)) ?? (unparsed ? referenced[0] : undefined);
  if (arithmetic !== undefined) return `arithmetic over data-derived variable ${arithmetic}`;
  const name = names.find((ref) => tainted.has(ref)) ?? (unparsed ? names[0] : undefined);
  return name === undefined ? null : `data-derived variable ${name} used as a variable name`;
}
