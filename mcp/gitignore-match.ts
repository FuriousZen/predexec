/**
 * Pure gitignore-pattern matcher, no dependencies, no fs, no regex.
 *
 * Claude Code's Read and Edit permission rules "use gitignore pattern syntax"
 * (https://code.claude.com/docs/en/permissions, "Read and Edit"), so
 * `policy-claude.ts` translates each rule's anchor into a base directory and
 * hands the remainder to this module. Semantics follow
 * https://git-scm.com/docs/gitignore (checked row-by-row against
 * `git check-ignore --no-index`):
 *
 *   - no slash (other than a trailing one) → matches at any depth;
 *     a leading or middle slash anchors the pattern to the base
 *   - `*` and `?` never cross `/`; `[...]` / `[!...]` / `[^...]` classes,
 *     POSIX `[:alpha:]`-style classes inside them
 *   - leading `**\/`, trailing `/**`, middle `/**\/` (repeats collapse, so
 *     `a/**\/**\/b` matches `a/b`); any other `**` is `*`
 *   - trailing `/` → directories only
 *   - `!` negates; the LAST matching pattern in list order wins
 *   - "It is not possible to re-include a file if a parent directory of that
 *     file is excluded": a path is matched when any ancestor directory is,
 *     whatever later negations say about the path itself
 *
 * TERMINATION: patterns come from settings files but paths are model-chosen,
 * so matching must be polynomial in both. A backtracking regex is not
 * (`*a*a*a*a*b` against 255 chars ran 16 s). Each segment is matched with
 * wildmatch's single-resume-point star backtracking — O(name × pattern) — and
 * `**` segments with a DP over (pattern segment, path segment) pairs.
 *
 * Invalid patterns (a reversed range `[z-a]`, an unknown POSIX class) never
 * throw: `gitignorePatternError` reports them so the policy layer can fail
 * closed, and the matcher treats them as matching nothing.
 *
 * Paths are POSIX, relative to the base, without a leading `./`.
 */

/** One character test inside a segment. */
type CharToken =
  | { kind: "literal"; char: string }
  | { kind: "any" } // `?`
  | { kind: "class"; negate: boolean; test: (ch: string) => boolean }
  | { kind: "star" }; // `*` (runs collapsed)

/** A path-segment matcher, or the `**` directory wildcard. */
type Segment = { kind: "globstar" } | { kind: "glob"; tokens: CharToken[] };

export interface GitignorePattern {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  segments: Segment[];
  /** Why the pattern is unusable, when it is; such a pattern matches nothing. */
  error?: string;
}

const POSIX_CLASSES: Record<string, (ch: string) => boolean> = {
  alnum: (c) => /^[A-Za-z0-9]$/.test(c),
  alpha: (c) => /^[A-Za-z]$/.test(c),
  blank: (c) => c === " " || c === "\t",
  cntrl: (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
  digit: (c) => c >= "0" && c <= "9",
  graph: (c) => c.charCodeAt(0) > 32 && c.charCodeAt(0) < 127,
  lower: (c) => c >= "a" && c <= "z",
  print: (c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127,
  punct: (c) => /^[!-/:-@[-`{-~]$/.test(c),
  space: (c) => /^[ \t\n\r\f\v]$/.test(c),
  upper: (c) => c >= "A" && c <= "Z",
  xdigit: (c) => /^[0-9A-Fa-f]$/.test(c),
};

class PatternError extends Error {}

/** Compile one gitignore line, or null for a blank/comment line. Never throws. */
export function compileGitignorePattern(line: string): GitignorePattern | null {
  let text = line;
  if (text.trim() === "" || text.startsWith("#")) return null;
  let negated = false;
  if (text.startsWith("!")) {
    negated = true;
    text = text.slice(1);
  } else if (text.startsWith("\\!") || text.startsWith("\\#")) {
    text = text.slice(1);
  }
  let dirOnly = false;
  if (text.endsWith("/") && !text.endsWith("\\/")) {
    dirOnly = true;
    text = text.replace(/\/+$/, "");
  }
  if (text === "") return null;
  const anchored = text.includes("/");
  if (text.startsWith("/")) text = text.replace(/^\/+/, "");

  const segments: Segment[] = [];
  try {
    for (const raw of text.split("/")) {
      if (raw === "**") {
        // Consecutive `**` segments collapse: `a/**/**/b` ≡ `a/**/b`.
        if (segments.at(-1)?.kind !== "globstar") segments.push({ kind: "globstar" });
      } else {
        segments.push({ kind: "glob", tokens: compileSegment(raw) });
      }
    }
  } catch (err) {
    const error = err instanceof PatternError ? err.message : String(err);
    return { negated, dirOnly, anchored, segments: [], error };
  }
  // An unanchored pattern matches at any depth: an implicit leading `**`.
  if (!anchored && segments[0]?.kind !== "globstar") segments.unshift({ kind: "globstar" });
  return { negated, dirOnly, anchored, segments };
}

/** Why `line` is not a usable gitignore pattern, or null when it is (or is blank). */
export function gitignorePatternError(line: string): string | null {
  return compileGitignorePattern(line)?.error ?? null;
}

function compileSegment(segment: string): CharToken[] {
  const tokens: CharToken[] = [];
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === "\\" && i + 1 < segment.length) {
      tokens.push({ kind: "literal", char: segment[++i]! });
    } else if (ch === "*") {
      while (segment[i + 1] === "*") i++; // a non-segment `**` is a plain `*`
      tokens.push({ kind: "star" });
    } else if (ch === "?") {
      tokens.push({ kind: "any" });
    } else if (ch === "[") {
      const parsed = parseClass(segment, i);
      if (parsed === null) tokens.push({ kind: "literal", char: "[" }); // unclosed: literal
      else {
        tokens.push(parsed.token);
        i = parsed.end;
      }
    } else {
      tokens.push({ kind: "literal", char: ch });
    }
  }
  return tokens;
}

/** Parse a bracket expression opened at `open`; null when unclosed. Throws PatternError when invalid. */
function parseClass(segment: string, open: number): { token: CharToken; end: number } | null {
  let i = open + 1;
  let negate = false;
  if (segment[i] === "!" || segment[i] === "^") {
    negate = true;
    i++;
  }
  const tests: ((ch: string) => boolean)[] = [];
  let first = true;
  for (; i < segment.length; i++) {
    let ch = segment[i]!;
    if (ch === "]" && !first) {
      return { token: { kind: "class", negate, test: (c) => tests.some((t) => t(c)) }, end: i };
    }
    first = false;
    if (ch === "[" && segment[i + 1] === ":") {
      const close = segment.indexOf(":]", i + 2);
      if (close === -1) return null;
      const name = segment.slice(i + 2, close);
      const test = POSIX_CLASSES[name];
      if (!test) throw new PatternError(`unknown character class [:${name}:]`);
      tests.push(test);
      i = close + 1;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) ch = segment[++i]!;
    if (segment[i + 1] === "-" && i + 2 < segment.length && segment[i + 2] !== "]") {
      let hi = segment[i + 2]!;
      let skip = 2;
      if (hi === "\\" && i + 3 < segment.length) {
        hi = segment[i + 3]!;
        skip = 3;
      }
      if (hi < ch) throw new PatternError(`reversed character range ${ch}-${hi}`);
      const lo = ch;
      tests.push((c) => c >= lo && c <= hi);
      i += skip;
      continue;
    }
    const literal = ch;
    tests.push((c) => c === literal);
  }
  return null;
}

function tokenMatches(token: CharToken, ch: string): boolean {
  switch (token.kind) {
    case "literal":
      return token.char === ch;
    case "any":
      return ch !== "/";
    case "class":
      return ch !== "/" && token.test(ch) !== token.negate;
    case "star":
      return false;
  }
}

/**
 * Wildmatch for one segment: iterative, with a single saved resume point for
 * the most recent `*`. Correct because every non-star token consumes exactly
 * one character; O(name × tokens) worst case.
 */
function matchSegment(tokens: readonly CharToken[], name: string): boolean {
  let t = 0;
  let n = 0;
  let starT = -1;
  let starN = 0;
  while (n < name.length) {
    const token = tokens[t];
    if (token?.kind === "star") {
      starT = t++;
      starN = n;
    } else if (token && tokenMatches(token, name[n]!)) {
      t++;
      n++;
    } else if (starT !== -1) {
      t = starT + 1;
      n = ++starN;
    } else {
      return false;
    }
  }
  while (tokens[t]?.kind === "star") t++;
  return t === tokens.length;
}

/**
 * Match pattern segments against path segments. `**` matches zero or more
 * segments, except a trailing `**` ("everything inside") which needs one.
 * DP over suffixes: O(pattern segments × path segments) cells.
 */
function matchSegments(pattern: readonly Segment[], path: readonly string[]): boolean {
  const P = pattern.length;
  const S = path.length;
  // ok[i][j]: pattern[i:] matches path[j:]
  let next: boolean[] = new Array<boolean>(S + 1).fill(false);
  next[S] = true; // empty pattern matches only the empty remainder
  for (let i = P - 1; i >= 0; i--) {
    const segment = pattern[i]!;
    const current: boolean[] = new Array<boolean>(S + 1).fill(false);
    if (segment.kind === "globstar") {
      const trailing = i === P - 1;
      // current[j] = OR over k >= j (k > j when trailing) of next[k]
      let any = false;
      for (let j = S; j >= 0; j--) {
        if (trailing) {
          current[j] = any;
          any = any || next[j]!;
        } else {
          any = any || next[j]!;
          current[j] = any;
        }
      }
    } else {
      for (let j = 0; j < S; j++) {
        current[j] = next[j + 1]! && matchSegment(segment.tokens, path[j]!);
      }
    }
    next = current;
  }
  return next[0]!;
}

/**
 * Build an ordered matcher over a pattern list. `isDir` says whether the final
 * path is a directory (ancestors always are). Returns true when the path is
 * matched — for a permission deny list, when it is denied.
 */
export function createGitignoreMatcher(lines: readonly string[]): (relPath: string, isDir?: boolean) => boolean {
  const patterns = lines
    .map(compileGitignorePattern)
    .filter((p): p is GitignorePattern => p !== null && p.error === undefined);
  const state = (segments: readonly string[], isDir: boolean): boolean => {
    let matched = false;
    for (const pattern of patterns) {
      if (pattern.dirOnly && !isDir) continue;
      if (matchSegments(pattern.segments, segments)) matched = !pattern.negated;
    }
    return matched;
  };
  return (relPath: string, isDir = false): boolean => {
    const segments = relPath.split("/").filter((s) => s !== "" && s !== ".");
    if (segments.length === 0) return false;
    for (let i = 1; i < segments.length; i++) {
      if (state(segments.slice(0, i), true)) return true;
    }
    return state(segments, isDir);
  };
}
