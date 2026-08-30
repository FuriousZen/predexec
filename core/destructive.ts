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
  if (EVAL_INTERPRETERS.has(head)) return /\s(-\w*[ecnp]\w*|--eval|--print)\b/.test(segment);
  if (EVAL_SHELLS.has(head)) return /\s-c\b/.test(segment);
  return false;
}

/**
 * The classifier. Returns the offending token for the hard-stop message, or
 * null when the command is (heuristically) read-only.
 */
function findDestructiveTokenInternal(cmd: string, depth: number): string | null {
  if (depth >= 32) return "complex shell syntax";
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

export function findDestructiveToken(cmd: string): string | null {
  return findDestructiveTokenInternal(cmd, 0);
}

export function isDestructiveCommand(cmd: string): boolean {
  return findDestructiveToken(cmd) !== null;
}
