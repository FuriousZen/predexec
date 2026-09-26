/**
 * Pure gitignore-pattern matcher, no dependencies, no fs.
 *
 * Claude Code's Read and Edit permission rules "use gitignore pattern syntax"
 * (https://code.claude.com/docs/en/permissions, "Read and Edit"), so
 * `policy-claude.ts` translates each rule's anchor into a base directory and
 * hands the remainder to this module. Semantics follow
 * https://git-scm.com/docs/gitignore:
 *
 *   - no slash (other than a trailing one) → matches at any depth;
 *     a leading or middle slash anchors the pattern to the base
 *   - `*` and `?` never cross `/`; `[...]` / `[!...]` / `[^...]` classes
 *   - leading `**\/`, trailing `/**`, middle `/**\/`; any other `**` is `*`
 *   - trailing `/` → directories only
 *   - `!` negates; the LAST matching pattern in list order wins
 *   - "It is not possible to re-include a file if a parent directory of that
 *     file is excluded": a path is matched when any ancestor directory is,
 *     whatever later negations say about the path itself
 *
 * Paths are POSIX, relative to the base, without a leading `./`.
 */

export interface GitignorePattern {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

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

  const segments = text.split("/");
  let body = "";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const first = i === 0;
    const last = i === segments.length - 1;
    if (segment === "**") {
      if (last && first) body += "[\\s\\S]*";
      else if (last) body += "/[\\s\\S]*"; // `a/**`: everything inside a
      else if (first) body += "(?:[\\s\\S]*/)?"; // `**/a`: a at any depth
      else body += "/(?:[\\s\\S]*/)?"; // `a/**/b`: zero or more dirs
      continue;
    }
    if (!first && segments[i - 1] !== "**") body += "/";
    body += segmentToRegex(segment);
  }
  const prefix = anchored ? "^" : "^(?:[\\s\\S]*/)?";
  return { negated, dirOnly, anchored, regex: new RegExp(`${prefix}${body}$`) };
}

/** One path segment's glob → regex source. `*`/`?`/classes never match `/`. */
function segmentToRegex(segment: string): string {
  let out = "";
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (ch === "\\" && i + 1 < segment.length) {
      out += escapeChar(segment[++i]!);
    } else if (ch === "*") {
      while (segment[i + 1] === "*") i++; // a non-segment `**` is a plain `*`
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const close = classEnd(segment, i);
      if (close === -1) {
        out += "\\["; // an unclosed class is a literal bracket
        continue;
      }
      let inner = segment.slice(i + 1, close);
      let negate = false;
      if (inner.startsWith("!") || inner.startsWith("^")) {
        negate = true;
        inner = inner.slice(1);
      }
      const escaped = inner.replace(/\\(.)/g, "$1").replace(/[\\\]^]/g, "\\$&");
      out += negate ? `[^/${escaped}]` : `[${escaped}]`;
      i = close;
    } else {
      out += escapeChar(ch);
    }
  }
  return out;
}

/** Index of the `]` closing a class opened at `open`, or -1. A leading `]` is literal. */
function classEnd(segment: string, open: number): number {
  let i = open + 1;
  if (segment[i] === "!" || segment[i] === "^") i++;
  if (segment[i] === "]") i++;
  for (; i < segment.length; i++) {
    if (segment[i] === "\\") i++;
    else if (segment[i] === "]") return i;
  }
  return -1;
}

function escapeChar(ch: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Build an ordered matcher over a pattern list. `isDir` says whether the final
 * path is a directory (ancestors always are). Returns true when the path is
 * matched — for a permission deny list, when it is denied.
 */
export function createGitignoreMatcher(lines: readonly string[]): (relPath: string, isDir?: boolean) => boolean {
  const patterns = lines.map(compileGitignorePattern).filter((p): p is GitignorePattern => p !== null);
  const state = (path: string, isDir: boolean): boolean => {
    let matched = false;
    for (const pattern of patterns) {
      if (pattern.dirOnly && !isDir) continue;
      if (pattern.regex.test(path)) matched = !pattern.negated;
    }
    return matched;
  };
  return (relPath: string, isDir = false): boolean => {
    const segments = relPath.split("/").filter((s) => s !== "" && s !== ".");
    if (segments.length === 0) return false;
    for (let i = 1; i < segments.length; i++) {
      if (state(segments.slice(0, i).join("/"), true)) return true;
    }
    return state(segments.join("/"), isDir);
  };
}
