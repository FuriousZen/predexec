/**
 * Harness-neutral shell inspection mechanics.
 *
 * This module deliberately does not know about policy syntax, precedence, or
 * verdicts. Hosts supply their wrapper vocabulary so policy adapters retain
 * ownership of those semantics.
 */

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

const DEFAULT_WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf", "noglob"]);
const DEFAULT_OPTION_TAKING_WRAPPERS = new Set(["timeout", "nice", "stdbuf"]);
const DEFAULT_BARE_ONLY_WRAPPERS = new Set(["command", "builtin", "xargs"]);
const DEFAULT_DURATION_PATTERN = /^\d+(?:\.\d+)?[smhd]?$/;
const TOKEN_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

const wrapperOptions = (options: WrapperInspectionOptions = {}) => ({
  wrappers: options.wrappers ?? DEFAULT_WRAPPERS,
  optionTakingWrappers: options.optionTakingWrappers ?? DEFAULT_OPTION_TAKING_WRAPPERS,
  bareOnlyWrappers: options.bareOnlyWrappers ?? DEFAULT_BARE_ONLY_WRAPPERS,
  optionArguments: options.optionArguments ?? new Map(),
  splitStringOptions: options.splitStringOptions ?? new Map(),
  durationPattern: options.durationPattern ?? DEFAULT_DURATION_PATTERN,
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
        if (end === -1) complete = false;
        else {
          bodies.push({ text: command.slice(i + 1, end), start: i + 1, end });
          i = end;
        }
      } else if (ch === "$" && command[i + 1] === "(") {
        const close = findParenSubstitutionClose(command, i + 2);
        if (close === -1) complete = false;
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
      if (end === -1) complete = false;
      else {
        bodies.push({ text: command.slice(i + 1, end), start: i + 1, end });
        i = end;
      }
      continue;
    }
    if ((ch === "$" || ch === "<" || ch === ">") && command[i + 1] === "(") {
      const close = findParenSubstitutionClose(command, i + 2);
      if (close === -1) complete = false;
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
  const commands: string[] = [];
  const pending: Array<{ text: string; depth: number; offset: number }> = [{ text: command, depth: 0, offset: 0 }];
  const seen = new Set<string>();
  const queued = new Set<string>([command]);
  let chars = 0;
  while (pending.length > 0) {
    pending.sort((a, b) => a.offset - b.offset);
    const item = pending.shift()!;
    if (seen.has(item.text)) continue;
    seen.add(item.text);
    if (commands.length >= maxCommands) return { commands, complete: false };
    const inspected = inspectCommandSubstitutions(item.text);
    const clauses = inspectShellCommandClauses(item.text);
    commands.push(item.text);
    chars += item.text.length;
    if (!inspected.complete || !clauses.complete || chars > maxChars) {
      return { commands, complete: false };
    }
    const children = executableBodyEvents(item.text)
      .sort((a, b) => a.start - b.start)
      .map((event) => event.text.trim())
      .filter((child) => child !== "" && !seen.has(child) && !queued.has(child));
    if (children.length > 0 && item.depth >= maxDepth) {
      return { commands, complete: false };
    }
    for (const body of children) {
      queued.add(body);
      const event = executableBodyEvents(item.text).find((candidate) => candidate.text.trim() === body);
      pending.push({
        text: body,
        depth: item.depth + 1,
        offset: item.offset + (event?.start ?? 0),
      });
    }
  }
  return { commands, complete: true };
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

  const clauses = inspectShellCommandClauses(command).clauses;
  const used = new Set<number>();
  for (const clause of clauses) {
    const text = clause.trim();
    if (!text) continue;
    // Clause text is emitted without leading reserved words. Locate it in the
    // original source; duplicate clause strings are harmlessly deduplicated by
    // the tree's existing seen/queued sets.
    const start = command.lastIndexOf(text);
    if (start === -1 || used.has(start)) continue;
    used.add(start);
    events.push({ text, start });
  }
  return events;
}

/** Tokenize one shell segment into argv-like words, removing shell quoting. */
export function tokenizeShellWords(segment: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let has = false;
  let q: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (q) {
      if (c === "\\" && q === '"') {
        cur += segment[i + 1] ?? "";
        i++;
      } else if (c === q) q = null;
      else cur += c;
      has = true;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) {
        tokens.push(cur);
        cur = "";
        has = false;
      }
      continue;
    }
    if (c === "\\") {
      cur += segment[i + 1] ?? "";
      i++;
      has = true;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) tokens.push(cur);
  return tokens;
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
  const groups = inspectParenthesizedBodies(segment);
  const functions = inspectFunctionDefinitions(segment);
  // Arithmetic evaluation uses the same punctuation as a subshell but does
  // not execute its contents as a command clause. Substitutions inside it are
  // still discovered independently by inspectCommandSubstitutions.
  if (/^\s*\(\(/.test(segment)) {
    return {
      clauses: uniqueClauses([...functions.bodies, ...groups.bodies]),
      complete: functions.complete && groups.complete,
    };
  }
  const caseClauses = extractCaseBranchBodies(segment);
  if (caseClauses !== null) {
    const hasCase = tokenizeShellWords(segment)[0] === "case";
    return {
      clauses: uniqueClauses([...caseClauses.bodies, ...functions.bodies, ...groups.bodies]),
      complete: caseClauses.complete && functions.complete && groups.complete &&
        (!hasCase || findUnquotedWord(segment, "in") !== -1 &&
          findUnquotedWord(segment, "esac") !== -1),
    };
  }
  const clauses: string[] = [];
  const parts = splitShellControlClauses(segment);
  const exposeAllParts = parts.length > 1;
  for (const part of parts) {
    const tokens = tokenizeShellWords(part);
    if (tokens.length === 0) continue;
    // Newline-separated function syntax (`f ()\n{ ... }`) is split into a
    // header fragment and its body by the generic control splitter. The
    // function extractor owns that header; treating it as a command would make
    // a valid definition look like an incomplete function invocation.
    if (isFunctionHeaderPart(part)) continue;
    if (tokens[0] === "coproc") {
      let start = 1;
      // Bash permits `coproc NAME { commands; }` as well as `coproc commands`.
      if (tokens[start] && tokens[start] !== "{" && tokens[start + 1] === "{") start++;
      if (tokens[start] === "{") start++;
      const body = tokens.slice(start).join(" ").replace(/}\s*$/, "").trim();
      if (body) clauses.push(body);
      continue;
    }
    if (SHELL_RESERVED_WORDS.has(tokens[0]!)) {
      const executable = stripReservedPrefix(tokens);
      if (executable) clauses.push(executable);
    } else if (exposeAllParts) {
      // A compound command's ordinary parts are terminal clauses too. A
      // single ordinary part is already represented by the current tree node;
      // omitting it there is the recursion guard for direct callers.
      clauses.push(part);
    }
  }
  return {
    clauses: uniqueClauses([...clauses, ...functions.bodies, ...groups.bodies]),
    complete: groups.complete && functions.complete,
  };
}

function isFunctionHeaderPart(part: string): boolean {
  const text = part.trim();
  return /^[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)$/.test(text) ||
    /^function\s+[A-Za-z_][A-Za-z0-9_]*$/.test(text);
}

const SHELL_RESERVED_WORDS = new Set([
  "{", "}", "(", ")", "!", "if", "then", "elif", "else", "fi",
  "while", "until", "do", "done", "for", "select", "function", "coproc",
]);

/** Extract POSIX/Bash function bodies, preserving quoted literals and groups. */
function inspectFunctionDefinitions(segment: string): { bodies: string[]; complete: boolean } {
  const bodies: string[] = [];
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

    let braceStart = -1;
    const namedHead = /[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)/.exec(segment.slice(i));
    if (namedHead && namedHead.index === 0 && functionPrefixAllowed(segment, i)) {
      const afterHead = segment.slice(i + namedHead[0].length).trimStart();
      if (!afterHead.startsWith("{")) {
        complete = false;
        i += namedHead[0].length - 1;
        continue;
      }
      braceStart = i + namedHead[0].length + segment.slice(i + namedHead[0].length).indexOf("{");
    } else {
      const documentedHead = /function\s+[A-Za-z_][A-Za-z0-9_]*/.exec(segment.slice(i));
      if (documentedHead && documentedHead.index === 0 && functionPrefixAllowed(segment, i)) {
        const afterHead = segment.slice(i + documentedHead[0].length).trimStart();
        if (!afterHead.startsWith("{")) {
          complete = false;
          i += documentedHead[0].length - 1;
          continue;
        }
        braceStart = i + documentedHead[0].length + segment.slice(i + documentedHead[0].length).indexOf("{");
      }
    }
    if (braceStart === -1) continue;
    const close = findMatchingBrace(segment, braceStart);
    if (close === -1) {
      complete = false;
      continue;
    }
    const body = segment.slice(braceStart + 1, close).trim();
    if (body) bodies.push(body);
    i = close;
  }
  if (quote !== null) complete = false;
  return { bodies: uniqueClauses(bodies), complete };
}

function functionPrefixAllowed(segment: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && /\s/.test(segment[i]!)) i--;
  if (i < 0) return true;
  const boundary = segment[i]!;
  if (";\n\r|&{}()".includes(boundary)) return true;
  const prefix = segment.slice(0, start).trim().split(/[;\n\r|&]/).pop()?.trim() ?? "";
  return /^(?:if|then|elif|else|while|until|do|for|select|!|function)$/.test(prefix) || /\)\s*$/.test(prefix);
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

function stripReservedPrefix(tokens: readonly string[]): string | null {
  let index = 0;
  while (index < tokens.length && SHELL_RESERVED_WORDS.has(tokens[index]!)) index++;
  // `function name { ... }` has a function name between reserved words.
  if (tokens[0] === "function" && index < tokens.length && !SHELL_RESERVED_WORDS.has(tokens[index]!)) index++;
  while (index < tokens.length && SHELL_RESERVED_WORDS.has(tokens[index]!)) index++;
  return index < tokens.length ? tokens.slice(index).join(" ") : null;
}

/** Split shell control separators without splitting quoted/nested syntax. */
function splitShellControlClauses(command: string): string[] {
  const clauses: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let parenDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\") {
      current += ch + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") {
      parenDepth++;
      current += ch;
      continue;
    }
    if (ch === ")" && parenDepth > 0) {
      parenDepth--;
      current += ch;
      continue;
    }
    if (ch === "{") {
      braceDepth++;
      current += ch;
      continue;
    }
    if (ch === "}" && braceDepth > 0) {
      braceDepth--;
      current += ch;
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
        current += ch + command[i + 1];
        i++;
        if (command[i] === "&") {
          current += command[i + 1] ?? "";
          if (command[i + 1] === "&") i++;
        }
        continue;
      }
      if (current.trim()) clauses.push(current.trim());
      current = "";
      if ((ch === "\r" && command[i + 1] === "\n") ||
          (ch === "&" && command[i + 1] === "&") ||
          (ch === "|" && command[i + 1] === "|")) i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) clauses.push(current.trim());
  return clauses;
}

/** Extract executable bodies from a complete `case ... in ... esac` command. */
function extractCaseBranchBodies(segment: string): { bodies: string[]; complete: boolean } | null {
  const tokens = tokenizeShellWords(segment);
  if (tokens[0] !== "case") return null;
  const start = findReservedWord(segment, "in");
  if (start === -1) return { bodies: [], complete: false };
  const bodyStart = start + 2;
  const end = findMatchingCaseEnd(segment, bodyStart);
  if (end === -1) return { bodies: [], complete: false };
  const body = segment.slice(bodyStart, bodyStart + end);
  const clauses: string[] = [];
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
    const clause = body.slice(branchStart, terminator.bodyEnd).trim();
    if (clause) clauses.push(clause);
    cursor = terminator.next;
  }
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
    if (ch === "(") {
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
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
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
  bodies: string[];
  complete: boolean;
}

/** Extract executable `(...)` groups, excluding quoted text, arithmetic, and substitutions. */
function inspectParenthesizedBodies(command: string): ParenthesizedBodyInspection {
  const bodies: string[] = [];
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
    bodies.push(command.slice(i + 1, close));
    i = close;
  }
  if (quote !== null) complete = false;
  return { bodies: uniqueClauses(bodies), complete };
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
    const spans = tokenizeShellWordSpans(cmd);
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

interface ShellWordSpan {
  value: string;
  start: number;
  end: number;
}

/** Tokenize while retaining source offsets so raw wrapper stripping preserves quotes/globs. */
function tokenizeShellWordSpans(segment: string): ShellWordSpan[] {
  const spans: ShellWordSpan[] = [];
  let start = -1;
  let value = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (start === -1 && /\s/.test(ch)) continue;
    if (start === -1) start = i;
    if (quote) {
      if (ch === "\\" && quote === '"') {
        value += segment[i + 1] ?? "";
        i++;
      } else if (ch === quote) quote = null;
      else value += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      value += segment[i + 1] ?? "";
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      spans.push({ value, start, end: i });
      start = -1;
      value = "";
      continue;
    }
    value += ch;
  }
  if (start !== -1) spans.push({ value, start, end: segment.length });
  return spans;
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
