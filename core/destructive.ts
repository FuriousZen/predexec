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
 * Deliberately out of scope: allowlist-only inversion (CLAUDE.md wants
 * tests/builds speculating), rsync/tar -x (mode-sensitive parsing).
 */

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

/** Unquoted `>` that is a real file redirect (guards: fd dups, /dev/null, `>=`). */
const REDIRECT_RE = /(?<![\d&=])>(?!\s*\/dev\/null|[&=])/;

/**
 * Word blocklist: file removers/movers/creators, process killers, `cp -`,
 * `sed -i` / `sort -o` anywhere in their segment, `tee`, `wget` (unless stdout
 * mode `-O-`/`-qO-`), `curl` with a file-output flag (`-o`/`-O`, incl.
 * clustered), `find -delete`, `crontab` (unless `-l` list), package-manager
 * installs/removes, and history-mutating git verbs.
 */
const WORD_RE =
  /\b(rm|rmdir|mv|dd|mkfs|chmod|chown|truncate|touch|mkdir|ln|shred|unlink|tee)\b|\b(kill|pkill|killall)\b|\bcp\s+-|\bsed\b[^|;&]*?\s-i\b|\bsort\b[^|;&]*?\s-o\b|\bwget\b(?![^|;&]*-q?O\s?-(?:\s|$|[|;&]))|\bcurl\b[^|;&]*\s-\w*[oO]\b|\bfind\b[^|;&]*\s-delete\b|\bcrontab\b(?!\s+-l\b)|\b(npm|pnpm|yarn|pip|pip3|apt|apt-get|brew|cargo|go)\s+(install|add|i|remove|uninstall|rm)\b|\bgit\s+(push|commit|reset|checkout|clean|rm|merge|rebase|restore|switch|apply|cherry-pick|revert|stash\s+(drop|pop|clear))\b/;

/**
 * Command heads that only ever read (absent an exception below). Membership
 * buys ONE thing: skipping the word-scan, so quoted writer words in their
 * arguments (grep/rg patterns, jq programs) stop false-positive hard-stopping.
 * The redirect check still applies to them.
 */
const READ_ONLY_HEADS = new Set([
  "cat", "ls", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "file",
  "stat", "du", "df", "ps", "env", "printenv", "echo", "printf", "which",
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
  awk: /system\s*\(/,
  gawk: /system\s*\(/,
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
  /\bfs\.\w*[Ww]rite\w*|writeFile\w*|appendFile\w*|rmSync|unlinkSync|mkdirSync|renameSync|rmdirSync|cpSync|createWriteStream|truncateSync|chmodSync|symlinkSync|os\.(remove|unlink|rename|mkdir|rmdir|makedirs)|shutil\.|write_text|write_bytes|open\([^)]*['"][wa]/;

/** Subshell/process-substitution markers: content we cannot attribute to a head. */
const OPAQUE_SUBSHELL_RE = /\$\(|`|<\(|>\(/;

/**
 * Split a compound command into pipeline segments on unquoted `|`, `;`, `&&`,
 * `||`, and bare `&` (but not `>&`/`&&` fd-dup/joins). Exception-safe: any
 * confusion degrades to the whole command as one segment (= status-quo scan).
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
      if (!inSingle && !inDouble && (ch === "|" || ch === ";" || ch === "&")) {
        // `2>&1` / `>&2`: an & directly after `>` is an fd dup, not a join.
        if (ch === "&" && cmd[i - 1] === ">") {
          current += ch;
          continue;
        }
        if (current.trim()) segments.push(current.trim());
        current = "";
        // swallow the second char of `&&` / `||`
        if (cmd[i + 1] === ch) i++;
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

/** Wrapper commands that defer to the next token. */
const WRAPPERS = new Set(["time", "nice", "nohup", "command", "xargs"]);

/**
 * The token that decides a segment's classification: skips VAR=val prefixes
 * and wrapper commands, resolves `/usr/bin/cat` → `cat`. `sudo`/`doas` are
 * returned as-is (never allowlisted). Null when nothing identifiable remains.
 */
export function effectiveHead(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/);
  for (const token of tokens) {
    if (/^\w+=/.test(token)) continue; // env-var prefix
    const base = token.replace(/^.*\//, "");
    if (WRAPPERS.has(base)) continue; // classify what it runs
    return base || null;
  }
  return null;
}

function isEvalInvocation(head: string, segment: string): boolean {
  if (EVAL_INTERPRETERS.has(head)) return /\s(-e|-c|--eval)\b/.test(segment);
  if (EVAL_SHELLS.has(head)) return /\s-c\b/.test(segment);
  return false;
}

/**
 * The classifier. Returns the offending token for the hard-stop message, or
 * null when the command is (heuristically) read-only.
 */
export function findDestructiveToken(cmd: string): string | null {
  const sanitized = sanitizeForRedirect(cmd);

  const redirect = REDIRECT_RE.exec(sanitized);
  if (redirect) return redirect[0].trim() || ">";

  const segments = splitCommandSegments(cmd);
  const heads = segments.map(effectiveHead);

  // Safe tier: every head is a pure reader, no exception fires, and there is
  // no subshell content we can't attribute. Word-scan skipped.
  const allSafe =
    !OPAQUE_SUBSHELL_RE.test(cmd) &&
    heads.every((head, i) => {
      if (head === null || !READ_ONLY_HEADS.has(head)) return false;
      const exception = HEAD_EXCEPTIONS[head];
      return !exception || !exception.test(segments[i]!);
    });
  if (allSafe) return null;

  const word = WORD_RE.exec(sanitized);
  if (word) return word[0].trim();

  // Interpreter eval payloads: scan the RAW segment — writer APIs live inside
  // the quotes the sanitizer deliberately preserves words in.
  for (let i = 0; i < segments.length; i++) {
    const head = heads[i];
    if (head && isEvalInvocation(head, segments[i]!)) {
      const writer = EVAL_WRITER_RE.exec(segments[i]!);
      if (writer) return writer[0].trim();
    }
  }

  return null;
}

export function isDestructiveCommand(cmd: string): boolean {
  return findDestructiveToken(cmd) !== null;
}
