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
 * `sed -i` / `sort -o` anywhere in their segment, `tee`, `wget` (unless stdout
 * mode `-O-`/`-qO-`), `curl` with a file-output flag (`-o`/`-O`, incl.
 * clustered), `find -delete`, `crontab` (unless `-l` list), package-manager
 * installs/removes, and history-mutating git verbs.
 */
const WORD_RE = new RegExp(
  [
    // file removers/movers/creators, process killers
    /\b(rm|rmdir|mv|dd|mkfs|chmod|chown|truncate|touch|mkdir|ln|shred|unlink|tee)\b/,
    /\b(kill|pkill|killall)\b/,
    /\bcp\s+-/,
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
  /\bfs\.\w*[Ww]rite\w*|writeFile\w*|appendFile\w*|rmSync|unlinkSync|mkdirSync|renameSync|rmdirSync|cpSync|createWriteStream|truncateSync|chmodSync|symlinkSync|os\.(remove|unlink|rename|mkdir|rmdir|makedirs)|shutil\.|write_text|write_bytes|open\([^)]*['"][wa]/;

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

/**
 * Wrapper commands that defer to the next token. `env` belongs here, not in
 * READ_ONLY_HEADS: bare `env` prints the environment, but `env rm -rf /` runs
 * rm. Treating it as a pure reader skipped the word scan entirely and let every
 * `env <writer>` through. As a wrapper, `env FOO=1 rm …` resolves to `rm` (the
 * VAR=val skip in effectiveHead already handles the assignment), and a bare
 * `env` falls through to the word scan, which is the safe direction.
 */
const WRAPPERS = new Set(["time", "nice", "nohup", "command", "xargs", "env"]);

/**
 * Privileged escalation heads. Never speculated on: a privileged command is
 * outside the recoverable read-only zone by definition, and detection would
 * otherwise rest entirely on the word scan matching whatever it wraps.
 */
const PRIVILEGE_HEADS = new Set(["sudo", "doas", "pkexec"]);

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

/**
 * In-place edit flags: `perl -i`, `perl -pi -e`, `ruby -i -pe` rewrite their
 * input files directly. There is no redirect and no blocklisted word, so
 * nothing else in the pipeline catches them.
 */
const INPLACE_EDIT_RE = /\s-\w*i(\.\w+)?\b/;

function isEvalInvocation(head: string, segment: string): boolean {
  // `-p`/`-n`/`--print` are eval flags too: `node -p 'require("fs").rmSync(…)'`
  // executes exactly like `-e`, and clustered forms (`perl -pi -e`) are common.
  if (EVAL_INTERPRETERS.has(head)) return /\s(-\w*[ecnp]\w*|--eval|--print)\b/.test(segment);
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

  // Privileged escalation is never speculated on, whatever it wraps.
  for (const head of heads) {
    if (head && PRIVILEGE_HEADS.has(head)) return head;
  }

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
    if (!head) continue;
    const segment = segments[i]!;
    if ((head === "awk" || head === "gawk") && AWK_WRITE_RE.test(segment)) {
      return AWK_WRITE_RE.exec(segment)![0].trim();
    }
    if (EVAL_INTERPRETERS.has(head) && INPLACE_EDIT_RE.test(segment)) return "-i";
    if (isEvalInvocation(head, segment)) {
      const writer = EVAL_WRITER_RE.exec(segment);
      if (writer) return writer[0].trim();
    }
  }

  return null;
}

export function isDestructiveCommand(cmd: string): boolean {
  return findDestructiveToken(cmd) !== null;
}
