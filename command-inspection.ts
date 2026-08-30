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

/**
 * Inspect command substitutions without treating punctuation in shell quotes
 * as syntax. This is intentionally a small lexer, not a shell evaluator: the
 * body is returned unchanged and callers decide how to classify it.
 */
export function inspectCommandSubstitutions(command: string): CommandSubstitutionInspection {
  const bodies: string[] = [];
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
          bodies.push(command.slice(i + 1, end));
          i = end;
        }
      } else if (ch === "$" && command[i + 1] === "(") {
        const close = findParenSubstitutionClose(command, i + 2);
        if (close === -1) complete = false;
        else {
          bodies.push(command.slice(i + 2, close));
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
        bodies.push(command.slice(i + 1, end));
        i = end;
      }
      continue;
    }
    if ((ch === "$" || ch === "<" || ch === ">") && command[i + 1] === "(") {
      const close = findParenSubstitutionClose(command, i + 2);
      if (close === -1) complete = false;
      else {
        bodies.push(command.slice(i + 2, close));
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
  options: { maxDepth?: number; maxCommands?: number; maxChars?: number } = {},
): CommandSubstitutionTree {
  const maxDepth = options.maxDepth ?? 32;
  const maxCommands = options.maxCommands ?? 512;
  const maxChars = options.maxChars ?? 1_000_000;
  const commands: string[] = [];
  const pending: Array<{ text: string; depth: number }> = [{ text: command, depth: 0 }];
  let chars = 0;
  while (pending.length > 0) {
    const item = pending.shift()!;
    const inspected = inspectCommandSubstitutions(item.text);
    commands.push(item.text);
    chars += item.text.length;
    if (!inspected.complete || commands.length > maxCommands || chars > maxChars) {
      return { commands, complete: false };
    }
    if (inspected.bodies.length > 0 && item.depth >= maxDepth) {
      return { commands, complete: false };
    }
    for (const body of inspected.bodies) pending.push({ text: body, depth: item.depth + 1 });
  }
  return { commands, complete: true };
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
 * Extract the executable-looking clause from one shell-control segment.
 * `splitCommandSegments` already separates command terminators; this small
 * seam removes syntax words which otherwise hide the first command in a
 * group (`{ git ...`, `if git ...`, `then git ...`). It intentionally only
 * strips a leading, quote-aware token sequence and returns no result when it
 * cannot identify one, leaving callers' conservative fallback intact.
 */
export function extractShellCommandClauses(segment: string): string[] {
  return inspectShellCommandClauses(segment).clauses;
}

export interface ShellClauseInspection {
  clauses: string[];
  complete: boolean;
}

/** Inspect executable clauses and report control syntax that cannot be split safely. */
export function inspectShellCommandClauses(segment: string): ShellClauseInspection {
  const caseClauses = extractCaseBranchBodies(segment);
  if (caseClauses !== null) {
    const hasCase = tokenizeShellWords(segment)[0] === "case";
    return {
      clauses: caseClauses,
      complete: !hasCase || findUnquotedWord(segment, "in") !== -1 &&
        findUnquotedWord(segment, "esac") !== -1,
    };
  }
  const tokens = tokenizeShellWords(segment);
  if (tokens.length === 0) return { clauses: [], complete: true };
  if (tokens[0] === "coproc") {
    let start = 1;
    // Bash permits `coproc NAME { commands; }` as well as `coproc commands`.
    if (tokens[start] && tokens[start] !== "{" && tokens[start + 1] === "{") start++;
    if (tokens[start] === "{") start++;
    if (start >= tokens.length) return { clauses: [], complete: false };
    const body = tokens.slice(start).join(" ").replace(/}\s*$/, "").trim();
    return body ? { clauses: [body], complete: true } : { clauses: [], complete: false };
  }
  const reserved = new Set([
    "{", "}", "(", ")", "!", "if", "then", "elif", "else", "fi",
    "while", "until", "do", "done", "for", "select", "function", "coproc",
  ]);
  let index = 0;
  while (index < tokens.length && reserved.has(tokens[index]!)) index++;
  if (tokens[0] === "case") return { clauses: [], complete: false };
  if (tokens[0] === "function" && index < tokens.length && !reserved.has(tokens[index]!)) index++;
  while (index < tokens.length && reserved.has(tokens[index]!)) index++;
  if (index === 0 || index >= tokens.length) return { clauses: [], complete: true };
  return { clauses: [tokens.slice(index).join(" ")], complete: true };
}

/** Extract executable bodies from a complete `case ... in ... esac` command. */
function extractCaseBranchBodies(segment: string): string[] | null {
  const tokens = tokenizeShellWords(segment);
  if (tokens[0] !== "case") return null;
  const start = findUnquotedWord(segment, "in");
  if (start === -1) return [];
  const bodyStart = start + 2;
  const end = findUnquotedWord(segment.slice(bodyStart), "esac");
  if (end === -1) return [];
  const body = segment.slice(bodyStart, bodyStart + end);
  const clauses: string[] = [];
  let branchStart = 0;
  let patternEnd = -1;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < body.length; i++) {
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
    if (ch === ")" && patternEnd === -1) {
      patternEnd = i;
      branchStart = i + 1;
      continue;
    }
    const isTerminator = ch === ";" && (body[i + 1] === ";" || body[i + 1] === "&");
    if (isTerminator && patternEnd !== -1) {
      const clause = body.slice(branchStart, i).trim();
      if (clause) clauses.push(clause);
      i++;
      if (body[i] === ";" || body[i] === "&") i++;
      patternEnd = -1;
    }
  }
  return clauses;
}

function findUnquotedWord(text: string, word: string): number {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i <= text.length - word.length; i++) {
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
        (i === 0 || /\s/.test(text[i - 1]!)) &&
        (i + word.length === text.length || /\s/.test(text[i + word.length]!))) return i;
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
