/**
 * predexec core — destructive-command heuristic.
 *
 * PURE TS, zero harness imports. Best-effort blocklist with an allowlist tier —
 * NOT a sandbox. Three-way classification per shell command:
 *
 *   1. redirect check (always): an unquoted `>` outside comparison spans writes.
 *   2. safe tier: when EVERY pipeline segment's head is a known pure reader
 *      (and no per-head exception fires), the word-scan is SKIPPED — so
 *      `grep "rm -rf" src/` (searching a codebase for writer words) is not
 *      misread as a write.
 *   3. otherwise: the word blocklist; plus, for interpreter eval flags
 *      (`node -e`, `python -c`, `sh -c`, …), an extra fs-writer-API scan —
 *      the quoted payload is executable there, not data.
 *
 * Deliberately out of scope: allowlist-only inversion (the adapters' `mutates`
 * guidance wants tests/builds speculating), rsync/tar -x (mode-sensitive parsing).
 */

import {
  extractShellCommandClauses,
  inspectCommandSubstitutions,
  inspectCommandSubstitutionTree,
  inspectShellCommandClauses,
} from "../command-inspection.ts";

/** Tool names that are definitively read-only — no regex analysis needed. */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
/** Tool names that are definitively mutating — hard-stop unconditionally. */
export const MUTATING_TOOLS = new Set(["edit", "write"]);

/**
 * Neutralize `>`/`<` where they are comparisons, not file redirects, so a read
 * is not misread as a write: inside shell quoted spans (awk/sed/jq programs and
 * grep patterns — e.g. `awk '$1 > 200'`, `grep "a->b" f`), `[[ ... ]]` tests, and
 * `(( ... ))` arithmetic. Only the angle brackets in those spans are dropped —
 * the rest of the span is kept, so a genuinely destructive word inside quotes
 * (`sh -c 'rm -rf /'`) is still caught by the word scan. Real redirects
 * (`echo x > f`) live OUTSIDE these spans and are untouched. Bare `test`/`[`
 * are left alone: outside `[[ ]]`, `test $x > 5` IS a real redirect to a file
 * named `5`.
 */
function sanitizeForRedirect(cmd: string): string {
  const dropAngles = (s: string) => s.replace(/[<>]/g, " ");
  return cmd
    .replace(/'[^']*'/g, dropAngles)
    .replace(/"[^"]*"/g, dropAngles)
    .replace(/\[\[[\s\S]*?\]\]/g, dropAngles)
    .replace(/\(\([\s\S]*?\)\)/g, dropAngles);
}

/**
 * Unquoted `>` that is a real file redirect.
 *
 * Guards live in the LOOKAHEAD: `2>&1` / `>&2` (fd dup) and `>=` are excluded by
 * `[&=]`, and `>/dev/null` by the /dev/null branch. The lookbehind only has to
 * exclude JS arrow functions (`=>`). It must NOT exclude a leading digit — an
 * explicit fd write like `echo hi 1>out.txt` or `2>err.log` is a real file write,
 * and excluding `\d` let every numbered-fd redirect through.
 */
const REDIRECT_RE = /(?<!=)>(?!\s*\/dev\/null|[&=])/;

/**
 * Word blocklist: file removers/movers/creators, process killers, `cp -`,
 * `cp`, `sed -i` / `sort -o` anywhere in their segment, `tee`, `wget` (unless stdout
 * mode `-O-`/`-qO-`), `curl` with a file-output flag (`-o`/`-O`, incl.
 * clustered), `find -delete`, `crontab` (unless `-l` list), package-manager
 * installs/removes, and history-mutating git verbs.
 */
const WORD_RE = new RegExp(
  [
    // file removers/movers/creators, process killers
    /\b(rm|rmdir|mv|dd|mkfs|chmod|chown|truncate|touch|mkdir|ln|shred|unlink|tee)\b/,
    /\b(kill|pkill|killall)\b/,
    /\bcp\b/,
    /\bsed\b[^|;&]*?\s-i\b/,
    /\bsort\b[^|;&]*?\s-o\b/,
    // `install` as a command (coreutils install copies+chmods); not `npm install`,
    // which the package-manager branch already covers.
    /(?<!\w[- ])\binstall\b\s+-/,
    // wget unless stdout mode (-O- / -qO-)
    /\bwget\b(?![^|;&]*-q?O\s?-(?:\s|$|[|;&]))/,
    // curl with a file-output flag: clustered short (-o/-O/-sLo) or long form.
    // The old pattern was `\s-\w*[oO]\b`, where `\w*` could not consume the
    // second dash, so `--output` slipped through.
    /\bcurl\b[^|;&]*\s(--output\b|--remote-name\b|-\w*[oO]\b)/,
    // piping a download straight into an interpreter — the classic installer
    // one-liner. Neither tier caught this: no redirect, no blocklisted word.
    /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|python3?|node|ruby|perl)\b/,
    /\bfind\b[^|;&]*\s-delete\b/,
    /\bcrontab\b(?!\s+-l\b)/,
    // package managers — install/remove plus the lockfile/link/upgrade verbs
    /\b(npm|pnpm|yarn|bun|pip|pip3|apt|apt-get|brew|cargo|go|gem|poetry|composer)\s+(install|add|i|ci|remove|uninstall|rm|update|upgrade|link|dlx|prune)\b/,
    /\bnpx\b/,
    /\bpython3?\s+(-m\s*pip|setup\.py)\b/,
    /\bmake\s+install\b/,
    // history-mutating git verbs. Option tokens may sit between `git` and the
    // verb (`git -C /repo reset --hard`, `git -c k=v commit`), so allow them.
    // Read-only spellings are carved back out with negative lookaheads.
    new RegExp(
      String.raw`\bgit\s+(?:-\w+(?:\s+\S+)?\s+|--[\w-]+(?:=\S+)?\s+)*` +
        String.raw`(push|commit|reset|checkout|clean|rm|mv|merge|rebase|restore|switch|apply|am|` +
        String.raw`cherry-pick|revert|gc|prune|filter-branch|worktree|submodule|` +
        String.raw`stash(?!\s+(list|show))|branch(?!\s+(-l\b|--list|-v\b))|tag(?!\s+-l\b)|` +
        String.raw`config(?!\s+(--get|--list|-l\b))|remote(?!\s+(-v\b|show\b)))\b`,
    ),
  ]
    .map((r) => r.source)
    .join("|"),
);

/** Git verbs whose ordinary invocation is read-only. */
const READ_ONLY_GIT_VERBS = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree",
  "grep", "blame", "describe", "shortlog", "name-rev", "for-each-ref",
]);

/** Git global options which consume the following argument as their value. */
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env",
]);

/** Git global options which do not consume an additional argument. */
const GIT_GLOBAL_OPTIONS = new Set([
  "-p", "-P", "--paginate", "--no-pager", "--no-replace-objects", "--no-lazy-fetch",
  "--no-optional-locks", "--no-advice", "--no-sparse", "--literal-pathspecs",
  "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--exec-path",
  "--html-path", "--man-path", "--info-path", "--version", "--help",
]);

/**
 * Command heads that only ever read (absent an exception below). Membership
 * buys ONE thing: skipping the word-scan, so quoted writer words in their
 * arguments (grep/rg patterns, jq programs) stop false-positive hard-stopping.
 * The redirect check still applies to them.
 */
const READ_ONLY_HEADS = new Set([
  "cat", "ls", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "file",
  "stat", "du", "df", "ps", "printenv", "echo", "printf", "which",
  "whereis", "type", "pwd", "whoami", "id", "uname", "date", "hostname",
  "sort", "uniq", "cut", "tr", "column", "comm", "join", "paste", "fold",
  "rev", "nl", "od", "xxd", "hexdump", "strings", "basename", "dirname",
  "realpath", "readlink", "md5sum", "sha1sum", "sha256sum", "diff", "cmp",
  "less", "more", "tree", "jq", "yq", "awk", "gawk", "sed", "find",
]);

/**
 * Per-head disqualifiers: when the regex fires on the segment, the head loses
 * its safe-tier pass and the command falls through to the word scan (which
 * carries matching writer tokens for sed -i / sort -o / find -delete, and
 * catches `find -exec rm` / `awk system("rm …")` via the quoted word).
 */
const HEAD_EXCEPTIONS: Record<string, RegExp> = {
  sed: /\s-i\b/,
  sort: /\s-o\b/,
  // awk writes without ever leaving its own program text: `awk 'BEGIN{print >
  // "/etc/passwd"}'`. The redirect check cannot see it (sanitizeForRedirect
  // drops angles inside quotes by design, so quoted comparisons don't
  // false-positive), so the head must lose its safe-tier pass instead.
  awk: /system\s*\(|\bprint\b[^}]*>|\bprintf\b[^}]*>|\bclose\s*\(/,
  gawk: /system\s*\(|\bprint\b[^}]*>|\bprintf\b[^}]*>|\bclose\s*\(/,
  find: /\s(-delete|-exec|-execdir|-ok)\b/,
};

/** Interpreters whose `-e`/`-c`/`--eval` payload is executable code, not data. */
const EVAL_INTERPRETERS = new Set(["node", "deno", "bun", "python", "python3", "ruby", "perl", "php"]);
const EVAL_SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

/**
 * fs-writer API tokens inside interpreter eval payloads. Heuristic: names the
 * common Node fs / Python os/shutil/pathlib writers; an obfuscated writer
 * (`require("fs")["write"+"FileSync"]`) will get through — this narrows the
 * gap, it does not close it.
 */
const EVAL_WRITER_RE =
  /\bfs\.\w*[Ww]rite\w*|writeFile\w*|appendFile\w*|rmSync|unlinkSync|mkdirSync|renameSync|rmdirSync|cpSync|createWriteStream|truncateSync|chmodSync|symlinkSync|os\.(remove|unlink|rename|mkdir|rmdir|makedirs)|shutil\.|write_text|write_bytes/;

/**
 * Language-specific eval scanners. Keep these as small API vocabularies rather
 * than one broad regex: read-only snippets such as File.read, fopen(...,"r"),
 * and Perl open(...,"<") must remain in the safe tier.
 */
const PERL_WRITER_FUNCTIONS =
  /\b(?:rename|unlink|truncate|mkdir|rmdir|chmod|chown|link|symlink)\s*\(/gi;
const PERL_WRITER_KEYWORDS = ["rename", "unlink", "truncate", "mkdir", "rmdir", "chmod", "chown", "link", "symlink"];
const RUBY_FILE_WRITER_FUNCTIONS = /\bFile\s*(?:\.|::)\s*(?:write|binwrite|delete|unlink|rename|truncate|symlink|link|utime)\s*\(/gi;
const RUBY_FILEUTILS_WRITER_FUNCTIONS = /\bFileUtils\s*(?:\.|::)\s*(?:rm|rm_f|rm_r|rm_rf|mv|move|cp|copy|cp_r|cp_lr|copy_entry|copy_file|copy_stream|mkdir|mkdir_p|makedirs|mkpath|touch|ln|ln_s|ln_sf|link|link_entry|symlink|install|chmod|chmod_R|chown|chown_R|remove|remove_file|remove_dir|remove_entry|remove_entry_secure|rmtree|safe_unlink)\s*\(/gi;
const RUBY_FILE_OPEN = /\bFile\s*(?:\.|::)\s*open\s*\(/gi;
const PHP_WRITER_FUNCTIONS = /\b(?:fwrite|fputs|file_put_contents|unlink|rename|copy|touch|mkdir|rmdir|chmod|chown|link|symlink|move_uploaded_file|ftruncate)\s*\(/gi;
const PHP_FOPEN = /\bfopen\s*\(/gi;
const MAX_LANGUAGE_ARGUMENT_LENGTH = 64 * 1024;
/** Maximum language-call candidates inspected in one eval payload. */
export const LANGUAGE_CALL_CANDIDATE_BUDGET = 256;
/** Bounds for recursive language-string interpolation extraction. */
export const LANGUAGE_INTERPOLATION_DEPTH_BUDGET = 32;
export const LANGUAGE_VIEW_CHARACTER_BUDGET = 64 * 1024;

interface LanguageCall { match: string; args: string | null; }

interface LanguageSyntaxOptions {
  hashComments: boolean;
  slashComments: boolean;
}

type InterpolationLanguage = "node" | "python" | "ruby" | "perl" | "php";

/**
 * Return an offset-preserving view of executable language source. Ordinary
 * strings, alternate literals, heredocs, and comments become spaces, while
 * interpolation bodies are recursively retained because they are executable
 * in JavaScript template strings, Ruby interpolated strings, and Python
 * f-strings. Perl only executes the explicit `${\ ...}`/`@{[ ... ]}` forms.
 * A malformed or over-budget construct returns null (fail closed).
 */
function executableLanguageView(source: string, language: InterpolationLanguage): string | null {
  if (source.length > LANGUAGE_VIEW_CHARACTER_BUDGET) return null;
  const chars = source.split("");
  let visited = 0;
  let depth = 0;
  const mask = (start: number, end: number) => {
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  };
  const step = () => ++visited <= LANGUAGE_VIEW_CHARACTER_BUDGET;
  const lineStart = (index: number) => index === 0 || source[index - 1] === "\n" || source[index - 1] === "\r";

  const parseCode = (start: number, end: number): number | null => {
    for (let i = start; i < end; i++) {
      if (!step()) return null;
      const ch = source[i]!;
      const next = source[i + 1];
      if (ch === "#" && (language === "python" || language === "ruby" || language === "perl" || language === "php")) {
        const commentEnd = source.slice(i).search(/[\r\n]/);
        const stop = commentEnd < 0 ? end : Math.min(end, i + commentEnd);
        mask(i, stop); i = stop - 1; continue;
      }
      if ((language === "php" || language === "node") && ch === "/" && next === "/") {
        const commentEnd = source.slice(i).search(/[\r\n]/);
        const stop = commentEnd < 0 ? end : Math.min(end, i + commentEnd);
        mask(i, stop); i = stop - 1; continue;
      }
      if ((language === "php" || language === "node") && ch === "/" && next === "*") {
        const close = source.indexOf("*/", i + 2);
        if (close < 0 || close + 2 > end) return null;
        mask(i, close + 2); i = close + 1; continue;
      }
      // Recursive interpolation walks may revisit a region that was masked by
      // its enclosing literal; executable code must be restored before nested
      // strings/comments are handled.
      chars[i] = source[i]!;
      if (language === "ruby" && lineStart(i) && /^\s*=begin(?:\s|$)/.test(source.slice(i))) {
        const marker = /(?:^|\r?\n)[ \t]*=end(?:[ \t]*)(?:\r?\n|$)/m.exec(source.slice(i));
        if (!marker) return null;
        const stop = i + marker.index + marker[0].length;
        mask(i, stop); i = stop - 1; continue;
      }
      if ((language === "ruby" || language === "perl" || language === "php") && ch === "<" && next === "<") {
        const heredoc = source.slice(i).match(/^<<<?[-~]?\s*(['"]?)([A-Za-z_]\w*)\1[ \t]*;?[ \t]*(?:\r?\n|\r)/);
        if (heredoc) {
          const bodyStart = i + heredoc[0].length;
          const terminator = new RegExp(`(?:^|\\r?\\n)[ \\t]*${heredoc[2]}[ \\t]*;?[ \\t]*(?:\\r?\\n|$)`, "m").exec(source.slice(bodyStart));
          if (!terminator) return null;
          const bodyEnd = bodyStart + terminator.index + terminator[0].length;
          const interpolating = language === "ruby" || (language === "perl" && heredoc[1] !== "'");
          mask(i, bodyStart);
          if (interpolating) {
            const parsed = maskInterpolatedLiteral(bodyStart, bodyEnd, language);
            if (parsed === null) return null;
          } else mask(bodyStart, bodyEnd);
          i = bodyEnd - 1; continue;
        }
      }
      if (language === "ruby" && ch === "%" && /[qQ]/.test(next ?? "")) {
        const parsed = parsePercent(i, end);
        if (parsed === null) return null;
        i = parsed - 1; continue;
      }
      if (language === "perl" && ch === "q" && (next === "q" || next === "w" || next === "x" || /[\[{(<'\"]/.test(next ?? ""))) {
        const parsed = parsePerlQuote(i, end);
        if (parsed === null) return null;
        i = parsed - 1; continue;
      }
      if (ch === "'" || ch === '"' || (language === "node" && ch === "`") || (language === "python" && (ch === "'" || ch === '"'))) {
        const triple = language === "python" && source.slice(i, i + 3) === ch.repeat(3);
        const prefix = language === "python" ? (source.slice(0, i).match(/(?:^|[^A-Za-z0-9_])([A-Za-z]+)$/)?.[1] ?? "") : "";
        const interpolating = language === "node" ? ch === "`" : language === "ruby" ? ch === '"' : language === "perl" ? ch === '"' : language === "python" && /f/i.test(prefix);
        const parsed = parseString(i, ch, triple, interpolating, end);
        if (parsed === null) return null;
        i = parsed - 1; continue;
      }
    }
    return end;
  };

  const parseInterpolated = (start: number, end: number, lang: InterpolationLanguage): number | null => {
    if (++depth > LANGUAGE_INTERPOLATION_DEPTH_BUDGET) return null;
    let braces = 1;
    let parsed: number | null = null;
    for (let i = start; i < end; i++) {
      if (!step()) { parsed = null; break; }
      const ch = source[i]!;
      const next = source[i + 1];
      if (ch === "#" && (lang === "python" || lang === "ruby" || lang === "perl" || lang === "php")) {
        const commentEnd = source.slice(i).search(/[\r\n]/);
        const stop = commentEnd < 0 ? end : Math.min(end, i + commentEnd);
        mask(i, stop); i = stop - 1; continue;
      }
      if ((lang === "php" || lang === "node") && ch === "/" && next === "/") {
        const commentEnd = source.slice(i).search(/[\r\n]/);
        const stop = commentEnd < 0 ? end : Math.min(end, i + commentEnd);
        mask(i, stop); i = stop - 1; continue;
      }
      if ((lang === "php" || lang === "node") && ch === "/" && next === "*") {
        const close = source.indexOf("*/", i + 2);
        if (close < 0 || close + 2 > end) { parsed = null; break; }
        mask(i, close + 2); i = close + 1; continue;
      }
      // The enclosing literal may have been masked before this recursive
      // pass; restore executable interpolation source as it is traversed.
      chars[i] = source[i]!;
      if (ch === "\\") { i++; continue; }
      if (ch === "'" || ch === '"' || (lang === "node" && ch === "`") || (lang === "python" && (ch === "'" || ch === '"'))) {
        const triple = lang === "python" && source.slice(i, i + 3) === ch.repeat(3);
        const prefix = lang === "python" ? (source.slice(0, i).match(/(?:^|[^A-Za-z0-9_])([A-Za-z]+)$/)?.[1] ?? "") : "";
        const nestedInterpolation = lang === "node" ? ch === "`" : lang === "ruby" ? ch === '"' : lang === "perl" ? ch === '"' : lang === "python" && /f/i.test(prefix);
        const stringEnd = parseString(i, ch, triple, nestedInterpolation, end);
        if (stringEnd === null) { parsed = null; break; }
        i = stringEnd - 1; continue;
      }
      if (ch === "{") braces++;
      else if (ch === "}" && --braces === 0) { parsed = i + 1; break; }
    }
    depth--;
    return parsed;
  };

  const maskInterpolatedLiteral = (start: number, end: number, lang: InterpolationLanguage): number | null => {
    for (let i = start; i < end; i++) {
      if (!step()) return null;
      const ch = source[i]!;
      if (ch === "\\") { mask(i, Math.min(end, i + 2)); i++; continue; }
      const marker = (lang === "ruby" && source.startsWith("#{", i)) ||
        (lang === "perl" && (source.startsWith("${\\", i) || source.startsWith("@{[", i)));
      if (marker) {
        const markerLength = lang === "ruby" ? 2 : source.startsWith("@{[", i) ? 3 : 3;
        mask(i, i + markerLength);
        const parsed = parseInterpolated(i + markerLength, end, lang);
        if (parsed === null) return null;
        i = parsed - 1;
      } else mask(i, i + 1);
    }
    return end;
  };

  const parseString = (start: number, quote: string, triple: boolean, interpolating: boolean, end: number): number | null => {
    const opening = triple ? 3 : 1;
    mask(start, Math.min(end, start + opening));
    for (let i = start + opening; i < end; i++) {
      if (!step()) return null;
      const ch = source[i]!;
      if (ch === "\\") { mask(i, Math.min(end, i + 2)); i++; continue; }
      if (triple ? source.slice(i, i + 3) === quote.repeat(3) : ch === quote) {
        mask(i, i + (triple ? 3 : 1)); return i + (triple ? 3 : 1);
      }
      const marker = language === "node" && quote === "`" ? source.startsWith("${", i) :
        language === "ruby" && interpolating ? source.startsWith("#{", i) :
        language === "perl" && interpolating ? source.startsWith("${\\", i) || source.startsWith("@{[", i) :
        language === "python" && interpolating && ch === "{" && source[i + 1] !== "{" ? true : false;
      if (language === "python" && interpolating && (source.startsWith("{{", i) || source.startsWith("}}", i))) {
        mask(i, i + 2); i++; continue;
      }
      if (marker) {
        const markerLength = language === "python" ? 1 : language === "perl" ? source.startsWith("@{[", i) ? 3 : 3 : 2;
        mask(i, i + markerLength);
        const parsed = parseInterpolated(i + markerLength, end, language);
        if (parsed === null) return null;
        i = parsed - 1;
        continue;
      }
      mask(i, i + 1);
    }
    return null;
  };

  const parseDelimited = (start: number, open: string, close: string, interpolating: boolean, end: number, openerLength: number): number | null => {
    mask(start, start + openerLength);
    let pairDepth = 1;
    for (let i = start + openerLength; i < end; i++) {
      if (!step()) return null;
      const ch = source[i]!;
      if (ch === "\\") { mask(i, Math.min(end, i + 2)); i++; continue; }
      if (interpolating && ((language === "ruby" && source.startsWith("#{", i)) || (language === "perl" && (source.startsWith("${\\", i) || source.startsWith("@{[", i))))) {
        const markerLength = language === "ruby" ? 2 : source.startsWith("@{[", i) ? 3 : 3;
        mask(i, i + markerLength);
        const parsed = parseInterpolated(i + markerLength, end, language);
        if (parsed === null) return null;
        i = parsed - 1; continue;
      }
      if (ch === open) pairDepth++;
      else if (ch === close && --pairDepth === 0) { mask(i, i + 1); return i + 1; }
      else mask(i, i + 1);
    }
    return null;
  };

  const parsePercent = (start: number, end: number): number | null => {
    const kind = source[start + 1]!;
    const open = source[start + 2];
    if (!open) return null;
    const close = ({ "{": "}", "[": "]", "(": ")", "<": ">" } as Record<string, string>)[open] ?? open;
    return parseDelimited(start, open, close, kind === "Q", end, 3);
  };

  const parsePerlQuote = (start: number, end: number): number | null => {
    const second = source[start + 1];
    const openerLength = second === "q" || second === "w" || second === "x" ? 2 : 1;
    const open = source[start + openerLength];
    if (!open) return null;
    const close = ({ "{": "}", "[": "]", "(": ")", "<": ">" } as Record<string, string>)[open] ?? open;
    return parseDelimited(start, open, close, second === "q", end, openerLength + 1);
  };

  const root = parseCode(0, source.length);
  return root === null ? null : chars.join("");
}

function maskLanguageCode(source: string, hashComments: boolean, slashComments: boolean): string {
  // Keep UTF-16 offsets aligned with RegExp indices used by call extraction.
  const chars = source.split("");
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const next = chars[i + 1];
    if (lineComment) {
      if (ch === "\n" || ch === "\r") lineComment = false;
      else chars[i] = " ";
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        chars[i] = " "; chars[++i] = " "; blockComment = false;
      } else if (ch !== "\n" && ch !== "\r") chars[i] = " ";
      continue;
    }
    if (quote) {
      if (escaped) { if (ch !== "\n" && ch !== "\r") chars[i] = " "; escaped = false; }
      else if (ch === "\\") {
        chars[i] = " ";
        // Perl single-quoted strings only treat backslash before another
        // backslash or quote as an escape. Do not let \q hide the closing
        // quote and make following executable code look like string data.
        if (quote !== "'" || next === "'" || next === "\\") escaped = true;
      }
      else if (ch === quote) { chars[i] = " "; quote = null; }
      else if (ch !== "\n" && ch !== "\r") chars[i] = " ";
      continue;
    }
    if (hashComments && ch === "#") { chars[i] = " "; lineComment = true; continue; }
    if (slashComments && ch === "/" && next === "/") {
      chars[i] = " "; chars[++i] = " "; lineComment = true; continue;
    }
    if (slashComments && ch === "/" && next === "*") {
      chars[i] = " "; chars[++i] = " "; blockComment = true; continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { chars[i] = " "; quote = ch; }
  }
  return chars.join("");
}

/** Remove language comments while retaining string literals and source shape. */
function stripLanguageComments(source: string, options: LanguageSyntaxOptions): string | null {
  const chars = source.split("");
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const next = chars[i + 1];
    if (lineComment) {
      if (ch === "\n" || ch === "\r") lineComment = false;
      else chars[i] = " ";
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        chars[i] = " "; chars[++i] = " "; blockComment = false;
      } else if (ch !== "\n" && ch !== "\r") chars[i] = " ";
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\" && (quote !== "'" || next === "'" || next === "\\")) escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (options.hashComments && ch === "#") {
      chars[i] = " "; lineComment = true; continue;
    }
    if (options.slashComments && ch === "/" && next === "/") {
      chars[i] = " "; chars[++i] = " "; lineComment = true; continue;
    }
    if (options.slashComments && ch === "/" && next === "*") {
      chars[i] = " "; chars[++i] = " "; blockComment = true; continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
  }
  return quote === null && !blockComment ? chars.join("") : null;
}

/** Capture a balanced call, ignoring comments and preserving the raw argument text. */
function captureLanguageCall(source: string, openIndex: number, options: LanguageSyntaxOptions): string | null {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let i = openIndex; i < source.length; i++) {
    if (i - openIndex > MAX_LANGUAGE_ARGUMENT_LENGTH) return null;
    const ch = source[i]!;
    const next = source[i + 1];
    if (lineComment) {
      if (ch === "\n" || ch === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\" && (quote !== "'" || next === "'" || next === "\\")) escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (options.hashComments && ch === "#") { lineComment = true; continue; }
    if (options.slashComments && ch === "/" && next === "/") { lineComment = true; i++; continue; }
    if (options.slashComments && ch === "/" && next === "*") { blockComment = true; i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(") paren++;
    else if (ch === ")") {
      if (paren === 0) return null;
      paren--;
      if (paren === 0 && bracket === 0 && brace === 0) return source.slice(openIndex + 1, i);
    } else if (ch === "[") bracket++;
    else if (ch === "]") {
      if (bracket === 0) return null;
      bracket--;
    } else if (ch === "{") brace++;
    else if (ch === "}") {
      if (brace === 0) return null;
      brace--;
    }
  }
  return null;
}

function findLanguageCalls(
  source: string,
  pattern: RegExp,
  hashComments: boolean,
  slashComments: boolean,
  language?: InterpolationLanguage,
): LanguageCall[] {
  const masked = language ? executableLanguageView(source, language) : maskLanguageCode(source, hashComments, slashComments);
  if (masked === null) return [{ match: "ambiguous language source", args: null }];
  const matcher = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
  const calls: LanguageCall[] = [];
  for (let match = matcher.exec(masked); match; match = matcher.exec(masked)) {
    if (calls.length >= LANGUAGE_CALL_CANDIDATE_BUDGET) {
      // Put the fail-closed marker first so every consumer, including callers
      // that inspect only the first match, observes the bounded traversal.
      return [{ match: "language call candidate budget", args: null }];
    }
    const text = match[0]!;
    const args = captureLanguageCall(source, match.index + text.lastIndexOf("("), { hashComments, slashComments });
    calls.push({ match: text.trim(), args });
  }
  return calls;
}

function findLanguageKeywords(source: string, keyword: string, hashComments: boolean, slashComments: boolean, language?: InterpolationLanguage): number[] {
  const masked = language ? executableLanguageView(source, language) : maskLanguageCode(source, hashComments, slashComments);
  if (masked === null) return [];
  const matcher = new RegExp(`\\b${keyword}\\b`, "g");
  const indexes: number[] = [];
  for (let match = matcher.exec(masked); match; match = matcher.exec(masked)) indexes.push(match.index);
  return indexes;
}

/** Split arguments at top-level commas, balancing all common expression delimiters. */
function splitTopLevelArguments(args: string, options: LanguageSyntaxOptions): string[] | null {
  if (args.length > MAX_LANGUAGE_ARGUMENT_LENGTH) return null;
  const cleaned = stripLanguageComments(args, options);
  if (cleaned === null) return null;
  const fields: string[] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\" && (quote !== "'" || cleaned[i + 1] === "'" || cleaned[i + 1] === "\\")) escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === "(") paren++;
    else if (ch === ")") { if (paren === 0) return null; paren--; }
    else if (ch === "[") bracket++;
    else if (ch === "]") { if (bracket === 0) return null; bracket--; }
    else if (ch === "{") brace++;
    else if (ch === "}") { if (brace === 0) return null; brace--; }
    else if (ch === "," && paren === 0 && bracket === 0 && brace === 0) {
      fields.push(cleaned.slice(start, i).trim()); start = i + 1;
    }
  }
  if (quote !== null || paren !== 0 || bracket !== 0 || brace !== 0) return null;
  fields.push(cleaned.slice(start).trim());
  return fields;
}

type StaticMode = { kind: "static"; value: string } | { kind: "ambiguous" };
type ModeLanguage = "ruby" | "perl" | "php" | "python";

function modeEscapeApplies(quote: "'" | '"', next: string | undefined): boolean {
  return quote === '"' || next === quote || next === "\\";
}

function hasModeInterpolation(body: string, language: ModeLanguage): boolean {
  if (language === "python") return false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\" && modeEscapeApplies('"', body[i + 1])) { i++; continue; }
    if (language === "ruby" && (body.startsWith("#{", i) || ch === "$" || ch === "@")) return true;
    if ((language === "perl" || language === "php") && (ch === "$" || ch === "@" || ch === "%")) return true;
  }
  return false;
}

function decodeModeEscapes(body: string, quote: "'" | '"'): StaticMode {
  let value = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\" || !modeEscapeApplies(quote, body[i + 1])) {
      value += ch;
      continue;
    }
    const next = body[++i]!;
    if (quote === "'") {
      value += next;
      continue;
    }
    const simple: Record<string, string> = {
      a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", s: " ", t: "\t", v: "\v",
      "\\": "\\", "\"": "\"", "'": "'",
    };
    if (simple[next] !== undefined) {
      value += simple[next]!;
      continue;
    }
    if (next === "x") {
      const hex = body.slice(i + 1).match(/^[0-9a-fA-F]{1,2}/)?.[0];
      if (!hex) return { kind: "ambiguous" };
      value += String.fromCharCode(parseInt(hex, 16));
      i += hex.length;
      continue;
    }
    if (/[0-7]/.test(next)) {
      const octal = (next + body.slice(i + 1).match(/^[0-7]{0,2}/)?.[0]).slice(0, 3);
      value += String.fromCharCode(parseInt(octal, 8));
      i += octal.length - 1;
      continue;
    }
    // Unknown escapes have language-specific semantics; treating them as
    // ambiguous keeps mode classification fail-closed.
    return { kind: "ambiguous" };
  }
  return { kind: "static", value };
}

/** Decode a complete static quoted argument, or classify it as ambiguous. */
function decodeStaticMode(arg: string, language: ModeLanguage): StaticMode {
  const text = arg.trim();
  const quote = text[0];
  if (quote !== "'" && quote !== '"') return { kind: "ambiguous" };
  for (let i = 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\" && modeEscapeApplies(quote, text[i + 1])) { i++; continue; }
    if (ch === quote) {
      if (!/^\s*$/.test(text.slice(i + 1))) return { kind: "ambiguous" };
      const body = text.slice(1, i);
      if (quote === '"' && hasModeInterpolation(body, language)) return { kind: "ambiguous" };
      return decodeModeEscapes(body, quote);
    }
  }
  return { kind: "ambiguous" };
}

function rubyWriteMode(mode: string): boolean {
  const normalized = mode.trim().toLowerCase();
  return /^[waxc]/.test(normalized) || normalized.includes("+");
}

function phpWriteMode(mode: string): boolean {
  const normalized = mode.trim().toLowerCase();
  return /^[waxc]/.test(normalized) || normalized.includes("+");
}

function perlOpenWriteMode(mode: string): boolean {
  const normalized = mode.trim();
  return normalized.startsWith(">") || normalized.startsWith("+") || normalized.startsWith("|") || normalized.startsWith("-|");
}

function interpreterEvalPayload(segment: string): string {
  const words = shellWords(segment);
  const evalFlag = /^(?:--eval|--print|--run|-r|-[epnc]|-[pn]*e[pn]*)$/;
  const index = words.findIndex((word) => evalFlag.test(word));
  return index < 0 ? segment : words.slice(index + 1).join(" ");
}

function languageWordScanSegment(head: string, segment: string): string {
  if (!isEvalInvocation(head, segment) || !EVAL_INTERPRETERS.has(head)) return segment;
  const payload = interpreterEvalPayload(segment);
  const language = (head === "node" || head === "deno" || head === "bun" ? "node" : head === "python3" ? "python" : head) as InterpolationLanguage;
  const view = executableLanguageView(payload, language);
  return view === null ? segment : `${head} ${view}`;
}

/** Capture bare Perl arguments, continuing across newline comments only while incomplete. */
function captureBarePerlArguments(
  source: string,
  masked: string,
  start: number,
  options: LanguageSyntaxOptions,
  minimumArguments: number,
): string | null {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let lastComma = start - 1;
  for (let i = start; i < masked.length; i++) {
    if (i - start > MAX_LANGUAGE_ARGUMENT_LENGTH) return null;
    const ch = masked[i]!;
    if (ch === "(") paren++;
    else if (ch === ")") {
      if (paren === 0) return masked.slice(start, i);
      paren--;
    } else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (ch === "{") brace++;
    else if (ch === "}") brace = Math.max(0, brace - 1);
    else if (ch === "," && paren === 0 && bracket === 0 && brace === 0) {
      lastComma = i;
    } else if ((ch === ";" || ch === "\n" || ch === "\r") && paren === 0 && bracket === 0 && brace === 0) {
      if (ch === ";") return source.slice(start, i);
      const beforeBoundary = masked.slice(start, i);
      const fields = splitTopLevelArguments(beforeBoundary, options);
      const lastField = masked.slice(lastComma + 1, i).trim();
      const incomplete = !fields || fields.length < minimumArguments || lastField.length === 0 || /(?:[,|&+\-*/%?:=]|\\)$/.test(lastField);
      if (!incomplete) return source.slice(start, i);
    }
  }
  return source.slice(start);
}

function findPerlWriter(payload: string): string | null {
  const common = findLanguageCalls(payload, PERL_WRITER_FUNCTIONS, true, false, "perl")[0];
  if (common) return common.match;
  for (const keyword of PERL_WRITER_KEYWORDS) {
    const index = findLanguageKeywords(payload, keyword, true, false, "perl")[0];
    if (index !== undefined) return keyword;
  }
  const masked = executableLanguageView(payload, "perl") ?? "";
  for (const index of findLanguageKeywords(payload, "sysopen", true, false, "perl")) {
    const afterKeyword = index + "sysopen".length;
    let cursor = afterKeyword;
    while (/\s/.test(masked[cursor] ?? "")) cursor++;
    const args = masked[cursor] === "("
      ? captureLanguageCall(payload, cursor, { hashComments: true, slashComments: false })
      : captureBarePerlArguments(payload, masked, cursor, { hashComments: true, slashComments: false }, 3);
    if (args === null) return "sysopen";
    const fields = splitTopLevelArguments(args, { hashComments: true, slashComments: false });
    // sysopen's third argument is the flags expression. Never inspect the
    // filename, trailing permissions, printed text, or comments for flags.
    if (fields === null || fields.length < 3) return "sysopen";
    const flags = fields[2]!;
    if (/\bO_(?:WRONLY|RDWR|CREAT|TRUNC|APPEND)\b/i.test(flags)) return "sysopen";
    // Unknown flags are ambiguous and therefore fail closed. O_RDONLY may
    // be combined with the non-mutating descriptor flags.
    if (!/\bO_RDONLY\b/i.test(flags)) return "sysopen";
  }
  for (const index of findLanguageKeywords(payload, "open", true, false, "perl")) {
    const afterKeyword = index + "open".length;
    let cursor = afterKeyword;
    while (/\s/.test(masked[cursor] ?? "")) cursor++;
    const args = masked[cursor] === "("
      ? captureLanguageCall(payload, cursor, { hashComments: true, slashComments: false })
      : captureBarePerlArguments(payload, masked, cursor, { hashComments: true, slashComments: false }, 2);
    if (args === null) return "open";
    const fields = splitTopLevelArguments(args, { hashComments: true, slashComments: false });
    if (fields === null || fields.length < 2) return "open";
    const mode = decodeStaticMode(fields[1]!, "perl");
    if (mode.kind === "ambiguous") return "open";
    if (perlOpenWriteMode(mode.value)) return `open ${mode.value}`;
  }
  const print = /\bprint\s+[A-Za-z_$][\w$]*\s+/.exec(executableLanguageView(payload, "perl") ?? "");
  return print?.[0]?.trim() ?? null;
}

function findRubyWriter(payload: string): string | null {
  const direct = findLanguageCalls(payload, RUBY_FILE_WRITER_FUNCTIONS, true, false, "ruby")[0];
  if (direct) return direct.match;
  const fileUtils = findLanguageCalls(payload, RUBY_FILEUTILS_WRITER_FUNCTIONS, true, false, "ruby")[0];
  if (fileUtils) return fileUtils.match;
  for (const call of findLanguageCalls(payload, RUBY_FILE_OPEN, true, false, "ruby")) {
    if (call.args === null) return call.match;
    const fields = splitTopLevelArguments(call.args, { hashComments: true, slashComments: false });
    if (fields === null || fields.length < 2) return call.match;
    const mode = decodeStaticMode(fields[1]!, "ruby");
    if (mode.kind === "ambiguous" || rubyWriteMode(mode.value) || /\b(?:WRONLY|RDWR|CREAT|TRUNC|APPEND)\b/.test(fields[1]!)) return call.match;
  }
  return null;
}

function findPhpWriter(payload: string): string | null {
  const direct = findLanguageCalls(payload, PHP_WRITER_FUNCTIONS, true, true, "php")[0];
  if (direct) return direct.match;
  for (const call of findLanguageCalls(payload, PHP_FOPEN, true, true, "php")) {
    if (call.args === null) return call.match;
    const fields = splitTopLevelArguments(call.args, { hashComments: true, slashComments: true });
    if (fields === null || fields.length < 2) return call.match;
    const mode = decodeStaticMode(fields[1]!, "php");
    if (mode.kind === "ambiguous" || phpWriteMode(mode.value)) return call.match;
  }
  return null;
}

/** Python's built-in open is the one generic writer API requiring mode parsing. */
function findPythonWriter(payload: string): string | null {
  for (const call of findLanguageCalls(payload, /\bopen\s*\(/gi, true, false, "python")) {
    if (call.args === null) return call.match;
    const fields = splitTopLevelArguments(call.args, { hashComments: true, slashComments: false });
    if (fields === null || fields.length < 2) continue;
    const mode = decodeStaticMode(fields[1]!, "python");
    if (mode.kind === "ambiguous") return call.match;
    if (/^[waxc]/i.test(mode.value) || mode.value.includes("+")) return call.match;
  }
  return null;
}

/**
 * awk/gawk writes that never leave the program text: `awk 'BEGIN{print >
 * "/etc/passwd"}'`. Scanned against the RAW segment, because the redirect check
 * runs on sanitized text where quoted angles are deliberately dropped, and the
 * word scan has no awk-specific token to match.
 */
const AWK_WRITE_RE = /\b(print|printf)\b[^}]*>|\bsystem\s*\(|\bclose\s*\(/;

/** Subshell/process-substitution markers: content we cannot attribute to a head. */
const OPAQUE_SUBSHELL_RE = /\$\(|`|<\(|>\(/;

/**
 * Split a compound command into pipeline segments on unquoted `|`, `;`, `&&`,
 * `||`, newlines, and bare `&` (but not `>&`/`&&` fd-dup/joins). Exception-safe:
 * any confusion degrades to the whole command as one segment (= status-quo scan).
 */
export function splitCommandSegments(cmd: string): string[] {
  try {
    const segments: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < cmd.length; i++) {
      const ch = cmd[i]!;
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      if (!inSingle && !inDouble && (ch === "|" || ch === ";" || ch === "&" || ch === "\n" || ch === "\r")) {
        // `2>&1` / `>&2`: an & directly after `>` is an fd dup, not a join.
        if (ch === "&" && cmd[i - 1] === ">") {
          current += ch;
          continue;
        }
        if (current.trim()) segments.push(current.trim());
        current = "";
        // swallow the second char of `&&` / `||`
        if (cmd[i + 1] === ch) i++;
        // Treat CRLF as one command separator.
        if (ch === "\r" && cmd[i + 1] === "\n") i++;
        continue;
      }
      current += ch;
    }
    if (current.trim()) segments.push(current.trim());
    return segments.length > 0 ? segments : [cmd];
  } catch {
    return [cmd];
  }
}

/**
 * Wrapper commands that defer to the next token. `env` belongs here, not in
 * READ_ONLY_HEADS: bare `env` prints the environment, but `env rm -rf /` runs
 * rm. Treating it as a pure reader skipped the word scan entirely and let every
 * `env <writer>` through. As a wrapper, `env FOO=1 rm …` resolves to `rm` (the
 * VAR=val skip in effectiveHead already handles the assignment), and a bare
 * `env` falls through to the word scan, which is the safe direction.
 */
const WRAPPERS = new Set(["time", "nice", "nohup", "command", "xargs", "env"]);

/** Wrapper flags whose next token is a flag value rather than the command. */
const WRAPPER_OPTIONS_WITH_VALUE: Record<string, Set<string>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  nice: new Set(["-n", "--adjustment"]),
  xargs: new Set([
    "-E", "-I", "-L", "-n", "-P", "-s", "-a", "--eof", "--end-of-file", "--replace",
    "--max-lines", "--max-procs", "--max-chars", "--arg-file",
  ]),
  command: new Set(),
  time: new Set(["-f", "--format", "-o", "--output"]),
  nohup: new Set(),
};

function wrapperOptionHasAttachedValue(wrapper: string, option: string): boolean {
  if (wrapper === "env") {
    return /^-(?:u|C|S).+/.test(option) || /^(?:--unset|--chdir|--split-string)=/.test(option);
  }
  if (wrapper === "nice") return /^-n.+/.test(option) || /^--adjustment=/.test(option);
  if (wrapper === "xargs") {
    return /^-[EILnPsa].+/.test(option) || /^(?:--eof|--end-of-file|--replace|--max-lines|--max-procs|--max-chars|--arg-file)=/.test(option);
  }
  if (wrapper === "time") return /^(?:--format|--output)=/.test(option);
  return false;
}

/**
 * Return the output option from a leading `time` wrapper, if present. Unlike
 * format-only options, `time -o FILE` and `time --output=FILE` open FILE
 * themselves before running the wrapped command, so resolving the inner head
 * first would incorrectly classify `time -o FILE printf ...` as a safe reader.
 */
function timeOutputOption(segment: string): string | null {
  const tokens = shellWords(segment);
  let wrapper: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/^\w+=/.test(token)) continue;
    const base = token.replace(/^.*\//, "");
    if (WRAPPERS.has(base)) {
      wrapper = base;
      continue;
    }
    if (!wrapper) return null;
    if (token === "--") {
      wrapper = null;
      continue;
    }
    if (wrapper === "time") {
      const isOutput = token === "-o" || token === "--output" || token.startsWith("-o") && token.length > 2 ||
        token.startsWith("--output=") || (token.startsWith("-") && !token.startsWith("--") && token.slice(1).includes("o"));
      if (isOutput) {
        return token;
      }
    }
    if (wrapper === "env") {
      const option = envOption(token);
      if (option.splitPayload !== undefined) {
        const payload = option.splitPayload || tokens[i + 1];
        if (payload) {
          const nested = timeOutputOption(payload);
          if (nested) return nested;
          if (!option.attached) i++;
        }
        continue;
      }
      if (option.takesArgument) {
        if (!option.attached) i++;
        continue;
      }
    }
    if (token.startsWith("-")) {
      const optionSet = WRAPPER_OPTIONS_WITH_VALUE[wrapper];
      if (optionSet?.has(token) && i + 1 < tokens.length && !wrapperOptionHasAttachedValue(wrapper, token)) i++;
      continue;
    }
    return null;
  }
  return null;
}

/** Extract unquoted parenthesized command groups for recursive inspection. */
function parenthesizedGroups(command: string): string[] {
  const groups: string[] = [];
  let quote: "'" | '"' | null = null;
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
    // `(( ... ))` is arithmetic syntax, not a command group. Continue scanning
    // after its opening pair so command substitutions nested inside it remain
    // visible to the existing opaque-substitution defense.
    if (command[i + 1] === "(") {
      i++;
      continue;
    }
    let depth = 1;
    let innerQuote: "'" | '"' | null = null;
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
      else if (inner === ")") {
        depth--;
        if (depth === 0) {
          groups.push(command.slice(i + 1, j));
          i = j;
          break;
        }
      }
    }
  }
  return groups;
}

/**
 * Privileged escalation heads. Never speculated on: a privileged command is
 * outside the recoverable read-only zone by definition, and detection would
 * otherwise rest entirely on the word scan matching whatever it wraps.
 */
const PRIVILEGE_HEADS = new Set(["sudo", "doas", "pkexec"]);

interface EnvOption {
  takesArgument: boolean;
  attached: boolean;
  splitPayload?: string;
}

/** Parse env's short clusters without mistaking an option value for a command. */
function envOption(token: string): EnvOption {
  if (token === "--ignore-environment") return { takesArgument: false, attached: false };
  for (const name of ["--unset", "--chdir"]) {
    if (token === name) return { takesArgument: true, attached: false };
    if (token.startsWith(`${name}=`)) return { takesArgument: true, attached: true };
  }
  if (token === "--split-string") return { takesArgument: true, attached: false, splitPayload: "" };
  if (token.startsWith("--split-string=")) return {
    takesArgument: true,
    attached: true,
    splitPayload: token.slice("--split-string=".length),
  };
  if (!token.startsWith("-") || token.startsWith("--")) return { takesArgument: false, attached: false };
  const flags = token.slice(1);
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (flag !== "u" && flag !== "C" && flag !== "S") continue;
    const rest = flags.slice(i + 1);
    return {
      takesArgument: true,
      attached: rest.length > 0,
      ...(flag === "S" ? { splitPayload: rest } : {}),
    };
  }
  return { takesArgument: false, attached: false };
}

/**
 * The token that decides a segment's classification: skips VAR=val prefixes
 * and wrapper commands, resolves `/usr/bin/cat` → `cat`. `sudo`/`doas` are
 * returned as-is (never allowlisted). Null when nothing identifiable remains.
 */
function effectiveHeadIndex(tokens: string[]): number | null {
  let wrapper: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/^\w+=/.test(token)) continue; // env-var prefix
    const base = token.replace(/^.*\//, "");
    if (WRAPPERS.has(base)) {
      wrapper = base;
      continue; // classify what it runs
    }
    if (wrapper && token === "--") {
      wrapper = null;
      continue;
    }
    if (wrapper === "env") {
      const option = envOption(token);
      if (option.takesArgument) {
        if (!option.attached) i++;
        continue;
      }
    }
    if (wrapper && token.startsWith("-")) {
      const optionSet = WRAPPER_OPTIONS_WITH_VALUE[wrapper];
      if (optionSet?.has(token) && i + 1 < tokens.length && !wrapperOptionHasAttachedValue(wrapper, token)) i++;
      continue;
    }
    return i;
  }
  return null;
}

export function effectiveHead(segment: string): string | null {
  const tokens = shellWords(segment);
  const index = effectiveHeadIndex(tokens);
  if (index === null) {
    const splitString = envSplitStringPayload(tokens);
    return splitString === null ? null : effectiveHead(splitString);
  }
  const base = tokens[index]!.replace(/^.*\//, "");
  return base || null;
}

/**
 * Split a command into shell words for Git's option/verb inspection. This is
 * intentionally narrower than a shell parser: quotes and escapes are kept
 * together so a quoted search pattern cannot become a false Git verb.
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const ch of command) {
    if (escaped) {
      // In a double-quoted shell word, backslash only quotes $, `, ", \,
      // and newline. Preserve it for PHP namespaces and Perl single-quoted
      // escape sequences such as \' so the eval payload remains intact.
      if (quote === "\"" && !/[\\$`\"\n]/.test(ch)) current += "\\";
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (escaped) current += "\\";
  if (current) words.push(current);
  return words;
}

/** Return the command string consumed by env's `-S`/`--split-string` option. */
function envSplitStringPayload(tokens: string[]): string | null {
  let envSeen = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const base = token.replace(/^.*\//, "");
    if (!envSeen) {
      if (base === "env") envSeen = true;
      continue;
    }
    if (token === "--") return null;
    const option = envOption(token);
    if (option.splitPayload !== undefined) return option.splitPayload || tokens[i + 1] || null;
    if (option.takesArgument) {
      if (!option.attached) i++;
      continue;
    }
    if (token.startsWith("-")) continue;
    return null;
  }
  return null;
}

function isGitReadOnlySubform(tokens: string[], verbIndex: number): boolean {
  const verb = tokens[verbIndex];
  const subform = tokens[verbIndex + 1];
  if (verb === "branch") return subform === "-l" || subform === "--list" || subform === "-v";
  if (verb === "tag") return subform === "-l" || subform === "--list";
  if (verb === "stash") return subform === "list" || subform === "show";
  if (verb === "config") {
    return subform === "--get" || subform?.startsWith("--get-") || subform === "--list" || subform === "-l";
  }
  if (verb === "remote") return subform === "-v" || subform === "show";
  return false;
}

/**
 * Return a mutation token for a Git segment whose verb is not allowlisted, or
 * null for an established read-only verb/subform. Global options are skipped
 * only in this verb position; their values are never treated as commands.
 */
function findGitMutationToken(segment: string): string | null {
  const tokens = shellWords(segment);
  const index = effectiveHeadIndex(tokens);
  if (index === null) {
    const splitString = envSplitStringPayload(tokens);
    return splitString === null ? null : findDestructiveTokenInternal(splitString, 1);
  }

  const gitIndex = index;
  if (tokens[gitIndex]!.replace(/^.*\//, "") !== "git") return null;

  let verbIndex = gitIndex + 1;
  while (verbIndex < tokens.length) {
    const option = tokens[verbIndex]!;
    if (option === "--") {
      verbIndex++;
      break;
    }
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
      verbIndex += 2;
      continue;
    }
    if (
      option.startsWith("--git-dir=") ||
      option.startsWith("--work-tree=") ||
      option.startsWith("--namespace=") ||
      option.startsWith("--super-prefix=") ||
      option.startsWith("--config-env=") ||
      option.startsWith("--exec-path=") ||
      (option.startsWith("-C") && option.length > 2) ||
      (option.startsWith("-c") && option.length > 2)
    ) {
      verbIndex++;
      continue;
    }
    if (GIT_GLOBAL_OPTIONS.has(option)) {
      verbIndex++;
      continue;
    }
    break;
  }

  const verb = tokens[verbIndex];
  if (!verb) return "git";
  if (READ_ONLY_GIT_VERBS.has(verb) || isGitReadOnlySubform(tokens, verbIndex)) return null;
  return `git ${verb}`;
}

/**
 * In-place edit flags: `perl -i`, `perl -pi -e`, `ruby -i -pe` rewrite their
 * input files directly. There is no redirect and no blocklisted word, so
 * nothing else in the pipeline catches them.
 */
const INPLACE_EDIT_RE = /\s-\w*i(\.\w+)?\b/;

function isEvalInvocation(head: string, segment: string): boolean {
  // `-p`/`-n`/`--print` are eval flags too: `node -p 'require("fs").rmSync(…)'`
  // executes exactly like `-e`, and clustered forms (`perl -pi -e`) are common.
  if (head === "php") return /\s(?:-\w*r\w*|--run)\b/.test(segment);
  if (EVAL_INTERPRETERS.has(head)) return /\s(-\w*[ecnp]\w*|--eval|--print)\b/.test(segment);
  if (EVAL_SHELLS.has(head)) return /\s-c\b/.test(segment);
  return false;
}

function findInterpreterWriter(head: string, segment: string): string | null {
  if (segment.length > MAX_LANGUAGE_ARGUMENT_LENGTH) return `${head} eval payload`;
  const payload = interpreterEvalPayload(segment);
  const language = (head === "node" || head === "deno" || head === "bun" ? "node" : head) as InterpolationLanguage;
  if (EVAL_INTERPRETERS.has(head) && executableLanguageView(payload, language) === null) return `${head} eval payload`;
  if (head === "python" || head === "python3") return findPythonWriter(payload);
  if (head === "perl") return findPerlWriter(payload);
  if (head === "ruby") return findRubyWriter(payload);
  if (head === "php") return findPhpWriter(payload);
  return null;
}

/**
 * The classifier. Returns the offending token for the hard-stop message, or
 * null when the command is (heuristically) read-only.
 */
function findDestructiveTokenInternal(cmd: string, depth: number): string | null {
  if (depth >= 32) return "complex shell syntax";
  // Avoid sending oversized interpreter payloads through the recursive shell
  // inspection machinery. They cannot be parsed within the language-call
  // budget, so fail closed before any potentially quadratic traversal.
  if (
    cmd.length > MAX_LANGUAGE_ARGUMENT_LENGTH &&
    /\b(?:node|deno|bun|python3?|ruby|perl|php)\b[^\n]*\s(?:-\w*[ecnp]\w*|--eval|--print|--run|-r)\b/.test(cmd)
  ) return "oversized interpreter eval";
  // Use the shared bounded traversal as a structural preflight so executable
  // control clauses and substitution bodies cannot disappear between the
  // core classifier and host policy adapters. Incomplete or over-budget shell
  // syntax is never allowed to fall through to the safe tier.
  if (!inspectCommandSubstitutionTree(cmd).complete) return "complex shell syntax";
  const sanitized = sanitizeForRedirect(cmd);

  const redirect = REDIRECT_RE.exec(sanitized);
  if (redirect) return redirect[0].trim() || ">";

  const segments = splitCommandSegments(cmd);

  // Quoted command substitutions still execute their `$()`/backtick bodies.
  // Recurse with a finite budget so nested syntax cannot hide a mutation while
  // malformed or adversarially deep input remains bounded.
  const substitutionInspection = inspectCommandSubstitutions(cmd);
  if (!substitutionInspection.complete) return "complex shell syntax";
  const substitutions = substitutionInspection.bodies;
  if (substitutions.length > 0) {
    if (depth >= 32) return "complex shell syntax";
    for (const substitution of substitutions) {
      const nested = findDestructiveTokenInternal(substitution, depth + 1);
      if (nested) return nested;
    }
  }

  // A case command with no closing `esac`, or a coprocess with no executable
  // body, is not safely decomposable. Never let the generic word scan turn an
  // opaque control construct into a SAFE result.
  const trimmed = cmd.trim();
  if (/^case\b/.test(trimmed) && !inspectShellCommandClauses(trimmed).complete) return "complex shell syntax";
  if (/^coproc(?:\s|$)/.test(trimmed) && extractShellCommandClauses(trimmed).length === 0) {
    return "complex shell syntax";
  }

  // Parenthesized groups execute their contents even though the outer shell
  // segment starts with `(`. Inspect each group recursively, while the
  // quote-aware extractor leaves literal parentheses untouched.
  for (const group of parenthesizedGroups(cmd)) {
    const nested = findDestructiveTokenInternal(group, depth + 1);
    if (nested) return nested;
  }

  // Braces and control words are shell syntax, not executable heads. Inspect
  // the command clause they introduce so `{ git add; }` and `if git add; ...`
  // cannot hide the effective command. Quoted literals are not tokenized as
  // leading syntax and remain in the established safe tier.
  for (const segment of segments) {
    for (const clause of extractShellCommandClauses(segment)) {
      const nested = findDestructiveTokenInternal(clause, depth + 1);
      if (nested) return nested;
    }
  }

  for (const clause of extractShellCommandClauses(cmd)) {
    const nested = findDestructiveTokenInternal(clause, depth + 1);
    if (nested) return nested;
  }

  // Check output-bearing `time` options before resolving the wrapped command's
  // head. The output file is a mutation even when the inner command is a pure
  // reader such as `printf`; `-a`/`--append` only becomes relevant when paired
  // with `-o`/`--output`.
  for (const segment of segments) {
    const output = timeOutputOption(segment);
    if (output) return `time ${output}`;
  }

  const heads = segments.map(effectiveHead);

  // Privileged escalation is never speculated on, whatever it wraps.
  for (const head of heads) {
    if (head && PRIVILEGE_HEADS.has(head)) return head;
  }

  // Git is allowlist-oriented at the verb position. Inspect it before the
  // generic scan so read-only Git search patterns remain data, not commands.
  const gitTokens = segments.map(findGitMutationToken);
  for (const token of gitTokens) {
    if (token) return token;
  }

  // Safe tier: every head is a pure reader, no exception fires, and there is
  // no subshell content we can't attribute. Word-scan skipped.
  const allSafe =
    !OPAQUE_SUBSHELL_RE.test(cmd) &&
    heads.every((head, i) => {
      const gitReadOnly = head === "git" && gitTokens[i] === null;
      if (head === null || (!READ_ONLY_HEADS.has(head) && !gitReadOnly)) return false;
      const exception = HEAD_EXCEPTIONS[head];
      return !exception || !exception.test(segments[i]!);
    });
  if (allSafe) return null;

  const wordScanText = segments.map((segment, i) => languageWordScanSegment(heads[i] ?? "", segment)).join(" | ");
  const word = WORD_RE.exec(sanitizeForRedirect(wordScanText));
  if (word) return word[0].trim();

  // Interpreter eval payloads: scan the RAW segment — writer APIs live inside
  // the quotes the sanitizer deliberately preserves words in.
  for (let i = 0; i < segments.length; i++) {
    const head = heads[i];
    if (!head) continue;
    const segment = segments[i]!;
    if ((head === "awk" || head === "gawk") && AWK_WRITE_RE.test(segment)) {
      return AWK_WRITE_RE.exec(segment)![0].trim();
    }
    if (EVAL_INTERPRETERS.has(head) && INPLACE_EDIT_RE.test(segment)) return "-i";
    if (isEvalInvocation(head, segment)) {
      const languageWriter = findInterpreterWriter(head, segment);
      if (languageWriter) return languageWriter;
      const writerPayload = interpreterEvalPayload(segment);
      const language = (head === "node" || head === "deno" || head === "bun" ? "node" : head === "python3" ? "python" : head) as InterpolationLanguage;
      const writerSource = executableLanguageView(writerPayload, language);
      if (writerSource === null) return `${head} eval payload`;
      const writer = EVAL_WRITER_RE.exec(writerSource);
      if (writer) return writer[0].trim();
    }
  }

  return null;
}

export function findDestructiveToken(cmd: string): string | null {
  return findDestructiveTokenInternal(cmd, 0);
}

export function isDestructiveCommand(cmd: string): boolean {
  return findDestructiveToken(cmd) !== null;
}
