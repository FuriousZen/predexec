/**
 * predexec core — evaluation of data-derived values (E-A).
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
 * `declare -p "$c"`, and (sh only) `unset -f "$c"`. These do not: `test -v`/
 * `[ -v`, and bare `declare|local "$c"` — but data can hold `=`, turning the
 * latter into the evaluating `"$c=1"` form, so every declare-family operand
 * built from data is flagged. `mapfile -C CALLBACK` evaluates its callback as
 * a command and is always flagged. Namerefs (`declare -n r=$c`, which
 * bash 3.2 rejects) and plain `unset "$c"` did not evaluate on 3.2 either, but
 * are flagged fail-closed for bash >= 4.3 semantics (the Linux default), where
 * array subscripts in them are evaluated — unverifiable on this 3.2 host.
 *
 * Further sources: `${c:=…}`/`${c=…}` default assignments, array assignments
 * whose elements glob or expand (`x=(*)`), and the positional parameters when
 * `set` gets a non-literal operand, a function defined here is called with
 * data arguments, or a `sh -c` payload is followed by arguments (all
 * positionals share the one `$@` bucket). A command substitution's output
 * used directly in an arithmetic context (`$(( $(cat f) ))`) is flagged with
 * no variable in between, and so is any data assigned to an integer-declared
 * name (`declare -i n=$(cat f)`), because that assignment evaluates. Name
 * operands of `mapfile`/`readarray`, `wait -p` and `[[ -R` (bash 4+) are
 * flagged fail-closed, like namerefs. A substitution's output used directly
 * in any name-operand position (`printf -v "$(cat f)"`) is flagged too.
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
/**
 * Pseudo-name for every positional parameter (`$1`…`$N`, `$@`, `$*`), tracked
 * as one bucket. It can never collide with a real identifier.
 */
const POSITIONAL = "$@";
/** A positional-parameter reference: `$1`, `${10}`, `$@`, `$*`, `${@}`. */
const POSITIONAL_REFERENCE_RE = /\$\{?[0-9@*]/;
/** A command substitution's start (`$(`, not `$((`) or a backtick. */
const SUBSTITUTION_START_RE = /\$\((?!\()|`/;
/** Shells whose `-c` payload sees the words after it as `$0`, `$1`, …. */
const SHELL_NAME_RE = /(?:^|\/)(?:ba|da|z|k|a|mk|)sh$/;
const IDENTIFIER_WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ARITHMETIC_TEST_OPERATORS = new Set(["-eq", "-ne", "-lt", "-le", "-gt", "-ge"]);
const DECLARE_HEADS = new Set(["declare", "typeset", "local", "export", "readonly"]);
/** `$name` / `${name…}` references in a word's raw text. */
const VARIABLE_REFERENCE_RE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
/** `read` options whose next word is not a variable name. */
const READ_VALUE_OPTIONS = new Set(["-p", "-d", "-i", "-n", "-N", "-t", "-u"]);
/** `mapfile`/`readarray` options whose next word is not the array name. */
const MAPFILE_VALUE_OPTIONS = new Set(["-d", "-n", "-O", "-s", "-u", "-C", "-c"]);
const COMMAND_PREFIX_WORDS = new Set(["command", "builtin"]);
/** Control-syntax prefixes; `for`/`select` stay, their loop variable is a source. */
/** `NAME() {`, `NAME ()`, `function NAME {`: a function definition's head. */
const FUNCTION_DEFINITION_RE = /^(?:function\s+([A-Za-z_][\w.:-]*)(?:\s*\(\s*\))?|([A-Za-z_][\w.:-]*)\s*\(\s*\))\s*/;
const CONTROL_PREFIX_RE = /^(?:(?:if|then|elif|else|fi|while|until|do|done|function|coproc|time)(?=\s|$)|[!{}()])\s*/;
/** A word that starts a redirection ends a `read`/`mapfile` name list. */
const REDIRECTION_WORD_RE = /^[0-9]*[<>&]/;
/** Any data-assignment construct, for the fallback when a context cannot be delimited. */
const DATA_CONSTRUCT_RE = /\$\(|`|\b(?:read|mapfile|readarray|getopts|printf|for|select|set)\b|\$\{[A-Za-z_][A-Za-z0-9_]*:?=/;

function identifiers(text: string): string[] {
  const found = text.match(IDENTIFIER_RE) ?? [];
  return POSITIONAL_REFERENCE_RE.test(text) ? [...found, POSITIONAL] : found;
}

function variableReferences(text: string): string[] {
  const found = [...text.matchAll(VARIABLE_REFERENCE_RE)].map((m) => m[1]!);
  return POSITIONAL_REFERENCE_RE.test(text) ? [...found, POSITIONAL] : found;
}

/** Map `${!1}` / `${!@}` names onto the positional bucket. */
function parameterName(name: string): string {
  return /^[A-Za-z_]/.test(name) ? name : POSITIONAL;
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
  /** The raw text of every covered arithmetic run. */
  covered: string[];
  /** Variables whose values the raw text uses as a name: `${!c}`, `[[ -v $c ]]`. */
  nameReferences: string[];
  /** True when a command substitution's output lands in an arithmetic context. */
  substitution: boolean;
  /** True when a command substitution's output is used as a variable name. */
  nameSubstitution: boolean;
  /** `${NAME:=value}` / `${NAME=value}`: NAME is assigned value. */
  defaults: Array<{ name: string; value: string }>;
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
  const defaults: Array<{ name: string; value: string }> = [];
  const names = { substitution: false };
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
      if (indirect && !/^(?:\[[@*]\]\}|[@*]\})/.test(text.slice(cursor, cursor + 4))) {
        nameReferences.push(parameterName(name[0]));
      }
      if (text[cursor] === "[") {
        const subscriptClose = match[cursor]!;
        if (subscriptClose === -1 || subscriptClose > close) continue;
        cursor = subscriptClose + 1;
      }
      // `${c:=value}` / `${c=value}` assign value to c.
      const assigns = text[cursor] === "=" ? 1 : text[cursor] === ":" && text[cursor + 1] === "=" ? 2 : 0;
      if (assigns > 0 && !indirect && /^[A-Za-z_]/.test(name[0])) {
        defaults.push({ name: name[0], value: text.slice(cursor + assigns, close) });
      }
      if (text[cursor] === ":" && !/[-=?+]/.test(text[cursor + 1] ?? "")) mark(cursor + 1, close);
    } else if (ch === "[" && /[A-Za-z0-9_]/.test(previous)) {
      markOpen(i, i + 1);
    } else if (ch === "[" && next === "[" && i > testEnd) {
      const close = match[i]!;
      const bodyEnd = close === -1 || close < i ? text.length : close - 1;
      if (bodyEnd === text.length) complete = false;
      testEnd = bodyEnd;
      markTestOperands(text, i + 2, bodyEnd, match, mark, nameReferences, names);
    }
  }
  const covered: string[] = [];
  let substitution = false;
  let depth = 0;
  let runStart = -1;
  for (let i = 0; i <= text.length; i++) {
    depth += cover[i]!;
    const inside = depth > 0 && i < text.length;
    if (inside && runStart === -1) runStart = i;
    if (!inside && runStart !== -1) {
      const run = text.slice(runStart, i);
      covered.push(run);
      if (SUBSTITUTION_START_RE.test(run)) substitution = true;
      runStart = -1;
    }
  }
  return {
    identifiers: covered.flatMap(identifiers),
    covered,
    nameReferences,
    substitution,
    nameSubstitution: names.substitution,
    defaults,
    complete,
  };
}

/**
 * Mark the words on either side of each arithmetic comparison in a `[[ … ]]`
 * body, and record the variables a `-v` operand names.
 */
function markTestOperands(
  text: string,
  start: number,
  end: number,
  match: Int32Array,
  mark: (start: number, end: number) => void,
  nameReferences: string[],
  names: { substitution: boolean },
): void {
  const words: Array<[number, number]> = [];
  let wordStart = -1;
  for (let i = start; i <= end; i++) {
    const blank = i === end || /\s/.test(text[i]!);
    if (!blank && wordStart === -1) wordStart = i;
    if (!blank) {
      // A `$( … )` or backtick substitution is one word even across blanks.
      const ch = text[i]!;
      const close = ch === "`" ? text.indexOf("`", i + 1) : ch === "(" || ch === "{" ? match[i]! : -1;
      if (close > i && close < end) i = close;
      continue;
    }
    if (blank && wordStart !== -1) {
      words.push([wordStart, i]);
      wordStart = -1;
    }
  }
  for (let w = 0; w < words.length; w++) {
    const [s, e] = words[w]!;
    const word = text.slice(s, e);
    // `-v NAME` and `-R NAME` (nameref test, bash 4.3+) parse NAME.
    if ((word === "-v" || word === "-R") && w + 1 < words.length) {
      const operand = text.slice(words[w + 1]![0], words[w + 1]![1]);
      nameReferences.push(...variableReferences(operand));
      if (SUBSTITUTION_START_RE.test(operand)) names.substitution = true;
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
  /** A command substitution's output used directly as a `let` expression. */
  substitution: boolean;
  /** A command substitution's output used directly as a variable-name operand. */
  nameSubstitution: boolean;
  /** `mapfile`/`readarray -C`: a callback evaluated as a command. */
  callback: boolean;
  /** Functions this command defines, and the commands it calls with data arguments. */
  functions: Set<string>;
  dataCalls: Set<string>;
  /** Every assignment's name and value identifiers, for the integer pass. */
  assignments: Array<{ name: string; values: string[] }>;
  /** Raw arithmetic text evaluated at word level: `let` operands, integer-declared assignment values. */
  arithmeticTexts: string[];
  /** Every assignment's name and raw value, for the integer pass. */
  rawAssignments: Array<{ name: string; value: string }>;
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
  // `x=(*)`: an array's elements undergo expansion and globbing, so a glob or
  // expansion in one fills the array with data (filenames, split output).
  if (value.startsWith("(") && arrayElementsExpand(rawValue)) flow.sources.add(name);
  const values = identifiers(rawValue);
  for (const from of values) addDependency(flow, name, from);
  flow.assignments.push({ name, values });
  flow.rawAssignments.push({ name, value: rawValue });
  if (intDeclared) {
    flow.integerNames.add(name);
    flow.arithmetic.push(...values);
  }
  return true;
}

/**
 * True when an `( … )` array value holds a glob (`*`, `?`, a `[` that is not
 * an `[index]=` prefix), a `$` expansion or a backtick. One forward pass: a
 * `[` scans ahead to the next `]` or blank and resumes there, so every
 * character is visited once.
 */
function arrayElementsExpand(rawValue: string): boolean {
  for (let i = 1; i < rawValue.length; i++) {
    const ch = rawValue[i]!;
    if (ch === "*" || ch === "?" || ch === "$" || ch === "`") return true;
    if (ch !== "[") continue;
    let j = i + 1;
    for (; j < rawValue.length; j++) {
      const inner = rawValue[j]!;
      if (inner === "]" || /\s/.test(inner)) break;
      if (inner === "*" || inner === "?" || inner === "$" || inner === "`") return true;
    }
    if (rawValue[j] !== "]" || rawValue[j + 1] !== "=") return true;
    i = j + 1;
  }
  return false;
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
    const definition = FUNCTION_DEFINITION_RE.exec(segment);
    if (definition) {
      flow.functions.add(definition[1] ?? definition[2]!);
      segment = segment.slice(definition[0].length);
      continue;
    }
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
  const dataWord = (word: ShellWord) => word.dynamic || /[*?[]/.test(word.value);
  // A function called with data arguments sees them as `$1`…; the definition
  // and call are matched after every segment is scanned.
  if (args.some(dataWord)) flow.dataCalls.add(command);
  // `sh -c 'payload' $0 $1 …`: the words after the payload are positional
  // parameters inside it. Any wrapper position counts (`xargs sh -c …`).
  for (let i = 0; i + 2 < words.length; i++) {
    if (!SHELL_NAME_RE.test(words[i]!.value)) continue;
    const option = words.findIndex((word, j) => j > i && /^-[A-Za-z]*c[A-Za-z]*$/.test(word.value));
    if (option !== -1 && option + 2 < words.length) flow.sources.add(POSITIONAL);
    break;
  }
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
      for (const word of args) {
        flow.arithmetic.push(...identifiers(rawWord(segment, word)));
        // bash expands the word, then evaluates it: a literal word's decoded
        // value is exactly the expression (`let "a<<=1"`).
        flow.arithmeticTexts.push(word.dynamic ? rawWord(segment, word) : word.value);
        if (SUBSTITUTION_START_RE.test(rawWord(segment, word))) flow.substitution = true;
      }
      break;
    case "set": {
      // `set -- $(cat f)` / `set -- *` sets the positional parameters from data.
      const operands = args.filter((word) => !/^[-+]/.test(word.value));
      if (operands.some(dataWord)) flow.sources.add(POSITIONAL);
      break;
    }
  }
}

const rawWord = (segment: string, word: ShellWord) => segment.slice(word.start, word.end);

/** Record the variables whose values `command` would use as variable names. */
function recordNameOperands(flow: Flow, segment: string, command: string, args: readonly ShellWord[]): void {
  const nameText = (text: string) => {
    flow.nameReferences.push(...variableReferences(text));
    if (SUBSTITUTION_START_RE.test(text)) flow.nameSubstitution = true;
  };
  const name = (word: ShellWord | undefined) => {
    if (word) nameText(rawWord(segment, word));
  };
  const options = args.filter((word) => /^[-+]/.test(word.value)).map((word) => word.value);
  switch (command) {
    case "read":
      for (let i = 0; i < args.length; i++) {
        const value = args[i]!.value;
        if (REDIRECTION_WORD_RE.test(value)) break;
        if (READ_VALUE_OPTIONS.has(value)) i++;
        else if (/^-[ers]*a./.test(value)) name(args[i]); // attached `-a"$c"`
        else if (!value.startsWith("-") || value === "-a") name(value === "-a" ? args[++i] : args[i]);
      }
      break;
    case "printf":
      for (let i = 0; i < args.length; i++) {
        if (args[i]!.value === "-v") name(args[i + 1]);
        else if (/^-v./.test(args[i]!.value)) name(args[i]); // attached `-v"$c"`
      }
      break;
    case "mapfile":
    case "readarray":
      // `-C CALLBACK` is evaluated as a command for every quantum of lines:
      // fail closed on any callback, literal or not (R13).
      if (args.some((word) => /^-[A-Za-z]*C/.test(word.value))) flow.callback = true;
      // bash 4+: the array name operand is parsed as a name. Flagged fail-closed.
      for (let i = 0; i < args.length; i++) {
        const value = args[i]!.value;
        if (REDIRECTION_WORD_RE.test(value)) break;
        if (MAPFILE_VALUE_OPTIONS.has(value)) i++;
        else if (!value.startsWith("-")) name(args[i]);
      }
      break;
    case "wait":
      // bash 5.1+: `wait -p NAME` assigns NAME. Flagged fail-closed.
      for (let i = 0; i < args.length; i++) {
        if (/^-[fn]*p$/.test(args[i]!.value)) name(args[i + 1]); // `-p`, `-np`, `-fp`
        else if (/^-[fn]*p./.test(args[i]!.value)) name(args[i]);
      }
      break;
    case "getopts":
      name(args[1]);
      break;
    case "unset":
      // `-f` evaluates on /bin/sh 3.2; plain and `-v` operands are flagged for
      // bash >= 4.3 semantics, which evaluates their array subscripts.
      args.forEach(name);
      break;
    case "declare":
    case "typeset":
    case "local":
    case "export":
    case "readonly": {
      // A bare operand counts too, for every head: data can hold `=`, which
      // turns `declare "$c"` into the `declare "$c=1"` assignment form. A
      // nameref (`-n`) also resolves its value as a name; namerefs are flagged
      // for bash >= 4.3 semantics (bash 3.2 has no `-n`).
      const nameref = options.some((option) => /^-[A-Za-z]*n/.test(option));
      for (const word of args) {
        if (/^[-+]/.test(word.value)) continue;
        const raw = rawWord(segment, word);
        const equals = raw.indexOf("=");
        if (equals === -1) {
          nameText(raw);
          continue;
        }
        nameText(raw.slice(0, equals));
        if (nameref) nameText(raw.slice(equals + 1));
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
function analyze(command: string): { ranges: ArithmeticRanges; flow: Flow } {
  const ranges = arithmeticRangeIdentifiers(command);
  const flow: Flow = {
    sources: new Set(),
    dependencies: new Map(),
    arithmetic: [],
    integerNames: new Set(),
    nameReferences: [],
    substitution: false,
    nameSubstitution: false,
    callback: false,
    functions: new Set(),
    dataCalls: new Set(),
    assignments: [],
    arithmeticTexts: [],
    rawAssignments: [],
    complete: ranges.complete,
  };
  const tree = inspectCommandSubstitutionTree(command);
  if (!tree.complete) flow.complete = false;
  for (const body of tree.commands) {
    for (const segment of splitCommandSegments(body)) scanSegment(flow, segment);
  }
  return { ranges, flow };
}

/** `NAME op= …`, `NAME++`/`NAME--`, `++NAME`/`--NAME` (not `==`, `<=`, `>=`, `!=`). */
const ARITHMETIC_ASSIGNMENT_RE =
  /(?<![0-9A-Za-z_#$])([A-Za-z_][A-Za-z0-9_]*)\s*(?:\[[^\]]*\]\s*)?(?:(?:<<|>>|[-+*\/%&^|])?=(?!=)|\+\+|--)|(?:\+\+|--)\s*([A-Za-z_][A-Za-z0-9_]*)/g;

/** `$name`/`${name}` right before an assignment operator, or after `++`/`--`. */
const INDIRECT_ASSIGNMENT_RE =
  /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\s*(?:\[[^\]]*\]\s*)?(?:(?:<<|>>|[-+*\/%&^|])?=(?!=)|\+\+|--)|(?:\+\+|--)\s*\$/;
/** A double-quoted simple expansion (`"$n"`, `"${n}"`): its quotes hide no spelling. */
const QUOTED_EXPANSION_RE = /"(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)"/g;
/**
 * A value with no name in it: an integer literal, or numbers and operators
 * only (`1<<2`). Evaluating it can reference or assign no variable.
 */
const NAMELESS_VALUE_RE = /^[\s0-9+\-*\/%<>=!&|^~()?:,]+$/;

/**
 * The text as the shell sees its bare arithmetic contexts: the contents of
 * single-quoted and `$'…'` strings are blanked, and so is double-quoted text
 * except the `$name`, `$((…))`, `$[…]` and `${…}` expansions that stay live there. The
 * quote characters themselves stay, so a quote splitting a name inside a
 * context (`P"AT"H=0`) is still seen. Same length as the input; linear.
 */
function liveArithmeticText(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  const closeOf = (start: number, open: string, close: string) => {
    let depth = 0;
    for (let k = start; k < text.length; k++) {
      if (text[k] === open) depth++;
      else if (text[k] === close && --depth === 0) return k;
    }
    return text.length - 1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\") { i++; continue; }
    if (ch === "'" || (ch === "$" && text[i + 1] === "'")) {
      const open = ch === "'" ? i : i + 1;
      let j = open + 1;
      while (j < text.length && text[j] !== "'") j += ch === "$" && text[j] === "\\" ? 2 : 1;
      blank(open + 1, Math.min(j, text.length));
      i = j;
      continue;
    }
    if (ch !== '"') continue;
    let j = i + 1;
    while (j < text.length && text[j] !== '"') {
      if (text[j] === "\\") { blank(j, Math.min(j + 2, text.length)); j += 2; continue; }
      if (text[j] === "$" && (text[j + 1] === "(" && text[j + 2] === "(" || text[j + 1] === "[" || text[j + 1] === "{")) {
        const bracket = text[j + 1]!;
        j = closeOf(j + 1, bracket, bracket === "(" ? ")" : bracket === "[" ? "]" : "}") + 1;
        continue;
      }
      // `$name` stays live too (`[[ "$n" -eq 3 ]]` evaluates n's value).
      if (text[j] === "$" && /[A-Za-z_]/.test(text[j + 1] ?? "")) {
        j++;
        while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) j++;
        continue;
      }
      blank(j, j + 1);
      j++;
    }
    i = j;
  }
  return out.join("");
}

/**
 * R44/R45: the names an arithmetic context assigns — every context
 * findTaintedEvaluation knows (`$((…))`, `((…))`, `$[…]`, `let`, `[[ … -eq … ]]`
 * operands, array subscripts, `${x:off:len}`, and assignments to
 * integer-declared names). `complete` is false when a context could not be
 * delimited; a caller then treats the command as assigning. `failClosed` is
 * set when the assigned names cannot be read off the text at all:
 * - a quote or backslash inside a context (`PA\TH=0`, `P"AT"H=0`), other
 *   than quotes around one simple expansion;
 * - an expansion as the target (`$v=0`, `++$v`);
 * - a name referenced there whose value this command assigns as anything
 *   but an integer literal (`w=PATH=0; (( w ))` assigns PATH).
 */
export function arithmeticAssignedNames(command: string): { names: string[]; complete: boolean; failClosed: string | null } {
  const { flow } = analyze(command);
  // Contexts come from the live text: quoted program text (`python3 -c
  // "print(d['a'])"`) holds no shell arithmetic.
  const ranges = arithmeticRangeIdentifiers(liveArithmeticText(command));
  const texts = [...ranges.covered, ...flow.arithmeticTexts];
  for (const { name, value } of flow.rawAssignments) if (flow.integerNames.has(name)) texts.push(value);
  const values = new Map<string, string[]>();
  for (const { name, value } of flow.rawAssignments) {
    let list = values.get(name);
    if (!list) values.set(name, (list = []));
    list.push(value);
  }
  const names: string[] = [];
  const complete = ranges.complete && flow.complete;
  let failClosed: string | null = null;
  for (const raw of texts) {
    const text = raw.replace(QUOTED_EXPANSION_RE, "$1");
    if (failClosed === null && /['"\\]/.test(text)) failClosed = "quoted arithmetic";
    if (failClosed === null && INDIRECT_ASSIGNMENT_RE.test(text)) failClosed = "indirect arithmetic assignment";
    for (const match of text.matchAll(ARITHMETIC_ASSIGNMENT_RE)) names.push(match[1] ?? match[2]!);
    for (const name of text.match(IDENTIFIER_RE) ?? []) {
      // Undelimited: every name in reach may be an assignment target.
      if (!complete) names.push(name);
      if (failClosed === null && (values.get(name) ?? []).some((value) => !NAMELESS_VALUE_RE.test(value))) {
        failClosed = "unknown arithmetic assignment";
      }
    }
  }
  return { names, complete, failClosed };
}

export function findTaintedEvaluation(command: string): string | null {
  const { ranges, flow } = analyze(command);
  if (flow.callback) return "mapfile callback evaluates a command";
  if (ranges.substitution || flow.substitution) return "arithmetic over command substitution output";
  if (ranges.nameSubstitution || flow.nameSubstitution) return "command substitution output used as a variable name";
  for (const { name, values } of flow.assignments) {
    if (flow.integerNames.has(name)) flow.arithmetic.push(...values);
  }
  for (const { name, value } of ranges.defaults) {
    const substitutions = inspectCommandSubstitutions(value);
    if (!substitutions.complete || substitutions.bodies.length > 0) flow.sources.add(name);
    for (const from of identifiers(value)) addDependency(flow, name, from);
  }
  for (const called of flow.dataCalls) if (flow.functions.has(called)) flow.sources.add(POSITIONAL);
  // An assignment to an integer-declared name evaluates the assigned value.
  const integer = [...flow.integerNames].find((name) => flow.sources.has(name));
  if (integer !== undefined) return `arithmetic over data-derived variable ${integer}`;
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
