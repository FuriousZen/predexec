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
const RAW_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;

const wrapperOptions = (options: WrapperInspectionOptions = {}) => ({
  wrappers: options.wrappers ?? DEFAULT_WRAPPERS,
  optionTakingWrappers: options.optionTakingWrappers ?? DEFAULT_OPTION_TAKING_WRAPPERS,
  bareOnlyWrappers: options.bareOnlyWrappers ?? DEFAULT_BARE_ONLY_WRAPPERS,
  optionArguments: options.optionArguments ?? new Map(),
  splitStringOptions: options.splitStringOptions ?? new Map(),
  durationPattern: options.durationPattern ?? DEFAULT_DURATION_PATTERN,
});

/** Extract command bodies from `$()`, backticks, and process substitutions. */
export function extractCommandSubstitutions(command: string): string[] {
  const found: string[] = [];
  let inSingle = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (inSingle) continue;

    if (ch === "`") {
      const end = command.indexOf("`", i + 1);
      if (end === -1) break;
      found.push(command.slice(i + 1, end));
      i = end;
      continue;
    }
    const opensParen = command[i + 1] === "(" && (ch === "$" || ch === "<" || ch === ">");
    if (!opensParen) continue;
    let depth = 0;
    for (let j = i + 1; j < command.length; j++) {
      const inner = command[j]!;
      if (inner === "(") depth++;
      else if (inner === ")") {
        depth--;
        if (depth === 0) {
          found.push(command.slice(i + 2, j));
          i = j;
          break;
        }
      }
    }
  }
  return found;
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
  const tokens = tokenizeShellWords(segment);
  if (tokens.length === 0) return [];
  const reserved = new Set([
    "{", "}", "(", ")", "!", "if", "then", "elif", "else", "fi",
    "while", "until", "do", "done", "for", "select", "function",
  ]);
  let index = 0;
  while (index < tokens.length && reserved.has(tokens[index]!)) index++;
  if (tokens[0] === "case") {
    index = 1;
    while (index < tokens.length && !tokens[index]!.endsWith(")")) index++;
    if (index < tokens.length) index++;
  }
  if (tokens[0] === "function" && index < tokens.length && !reserved.has(tokens[index]!)) index++;
  while (index < tokens.length && reserved.has(tokens[index]!)) index++;
  if (index === 0 || index >= tokens.length) return [];
  return [tokens.slice(index).join(" ")];
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
    cmd = cmd.replace(RAW_ASSIGNMENT_PATTERN, "").trimStart();
    const tokens = cmd.split(/\s+/);
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
        if (drop < tokens.length) cmd = tokens.slice(drop).join(" ");
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
