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
 *      the quoted payload is executable there, not data — and then a reader
 *      allowlist: an inline program is mutating unless every call it makes
 *      is a known reader (READER_ALLOWLISTS).
 *
 * Deliberately out of scope: allowlist-only inversion for commands in general
 * (the adapters' `mutates` guidance wants tests/builds speculating), rsync/tar
 * -x (mode-sensitive parsing).
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
function maskHeredocBodies(cmd: string): string {
  const chars = cmd.split("");
  const ranges: Array<[number, number]> = [];
  const pending: Array<{ delimiter: string; stripTabs: boolean; bodyStart: number }> = [];
  let quote: "'" | '"' | null = null;
  let lineStart = 0;
  while (lineStart < cmd.length) {
    const newline = cmd.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? cmd.length : newline;
    if (pending.length > 0) {
      const candidate = cmd.slice(lineStart, lineEnd).replace(/\r$/, "");
      const expected = pending[0]!;
      const comparable = expected.stripTabs ? candidate.replace(/^\t+/, "") : candidate;
      if (comparable === expected.delimiter) {
        ranges.push([expected.bodyStart, newline < 0 ? lineEnd : newline + 1]);
        pending.shift();
        if (pending.length > 0) pending[0]!.bodyStart = newline < 0 ? lineEnd : newline + 1;
      }
      lineStart = newline < 0 ? cmd.length : newline + 1;
      continue;
    }
    for (let i = lineStart; i < lineEnd; i++) {
      const ch = cmd[i]!;
      if (ch === "\\" && quote !== "'") { i++; continue; }
      if (quote !== null) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch !== "<" || cmd[i + 1] !== "<" || cmd[i + 2] === "<") continue;
      let cursor = i + 2;
      let stripTabs = false;
      if (cmd[cursor] === "-") { stripTabs = true; cursor++; }
      while (cursor < lineEnd && /[ \t]/.test(cmd[cursor]!)) cursor++;
      let delimiter = "";
      const delimiterQuote = cmd[cursor] === "'" || cmd[cursor] === '"' ? cmd[cursor++] : null;
      while (cursor < lineEnd) {
        const next = cmd[cursor]!;
        if (delimiterQuote !== null) {
          if (next === delimiterQuote) { cursor++; break; }
          delimiter += next;
        } else if (/[A-Za-z0-9_]/.test(next)) delimiter += next;
        else break;
        cursor++;
      }
      if (delimiter.length > 0) pending.push({ delimiter, stripTabs, bodyStart: lineEnd + (newline < 0 ? 0 : 1) });
      i = Math.max(i, cursor - 1);
    }
    lineStart = newline < 0 ? cmd.length : newline + 1;
  }
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  }
  return chars.join("");
}

function sanitizeForRedirect(cmd: string): string {
  const dropAngles = (s: string) => s.replace(/[<>]/g, " ");
  return maskHeredocBodies(cmd)
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
const REDIRECT_RE = /(?<!=)>(?!\s*\/dev\/null(?=\s|$|[|;&<>\n\r])|[=]|&\s*(?:\d+|-|\/dev\/null)(?=\s*(?:$|[|;&<>\n\r])))/;

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

/** Git global options that are themselves read-only queries when no verb follows. */
const GIT_READ_ONLY_GLOBAL_OPTIONS = new Set([
  "--exec-path", "--html-path", "--man-path", "--info-path", "--version", "--help",
]);

/** Git configuration keys whose values can invoke a process while reading. */
const GIT_COMMAND_CONFIG_KEY_RE = /^(?:core\.pager(?:\..*)?|pager(?:\..*)?|core\.fsmonitor|diff\..*(?:external|textconv)|diff\..+\.command|filter(?:\..*)?|core\.(?:sshcommand|gitproxy)|credential\.helper(?:\..*)?)$/i;

/**
 * Environment variables that can make an otherwise read-only Git invocation
 * execute caller-controlled programs. Git reads these before dispatching the
 * verb, so they belong to the invocation prefix rather than the argument
 * data. Config-file selectors are included because the selected config can
 * install any of the command-bearing settings above.
 */
const GIT_COMMAND_ENV_NAME_RE = new RegExp(
  "^(?:GIT_EXTERNAL_DIFF|GIT_CONFIG(?:_PARAMETERS|_(?:GLOBAL|SYSTEM))?|" +
  "GIT_CONFIG_(?:COUNT|KEY_|VALUE_)[A-Za-z0-9_]*|(?:GIT_)?PAGER|" +
  "GIT_(?:SSH|SSH_COMMAND|EDITOR|SEQUENCE_EDITOR|ASKPASS|PROXY_COMMAND|EXEC_PATH|DIFF_TOOL|MERGE_TOOL))$",
  "i",
);

/** Shell builtins that evaluate or replace command text rather than reading it. */
const SHELL_COMMAND_CONTROL_HEADS = new Set(["eval", "source", ".", "exec"]);

/**
 * Command heads that only ever read (absent a write/exec form caught by
 * READ_ONLY_HEAD_WRITES below). Membership buys ONE thing: skipping the
 * word-scan, so quoted writer words in their arguments (grep/rg patterns, jq
 * programs) stop false-positive hard-stopping. The redirect check still
 * applies to them.
 */
const READ_ONLY_HEADS = new Set([
  "cat", "ls", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "file",
  "stat", "du", "df", "ps", "printenv", "echo", "printf", "which",
  "whereis", "type", "pwd", "whoami", "id", "uname", "date", "hostname",
  "sort", "uniq", "cut", "tr", "column", "comm", "join", "paste", "fold",
  "rev", "nl", "od", "xxd", "hexdump", "strings", "basename", "dirname",
  "realpath", "readlink", "md5sum", "sha1sum", "sha256sum", "diff", "cmp",
  "less", "more", "tree", "jq", "yq", "awk", "gawk", "mawk", "sed", "find",
]);

/**
 * Decides whether one invocation of a read-only head writes or execs. Receives
 * the argv AFTER the head (wrappers and env assignments already stripped) and
 * returns the offending token for the hard-stop message, or null when the
 * invocation only reads. `context.inspect` runs a nested command argv
 * (`find -exec`) back through the full classifier; `context.followingText` is
 * the raw command text after this segment (null when it cannot be located).
 */
interface ReadOnlyHeadContext {
  inspect: (argv: string[]) => string | null;
  followingText: string | null;
  /** Leading `NAME=value` assignments (shell prefix or `env`) for this head. */
  assignments: readonly string[];
}
type ReadOnlyHeadWriteCheck = (args: string[], context: ReadOnlyHeadContext) => string | null;

type GetoptArity = "flag" | "value" | "optional";
interface GetoptSpec {
  short: Record<string, GetoptArity>;
  long: Record<string, GetoptArity>;
  /** awk stops at its first operand (the program); sed/sort permute. */
  stopAtOperand?: boolean;
}
type GetoptItem = { kind: "option"; name: string; value?: string } | { kind: "operand"; value: string };

/**
 * GNU getopt_long, as sed/sort/gawk parse their argv: short clusters with
 * attached or following values, and long options abbreviable to any unique
 * prefix (`sed --in` IS `--in-place`). Returns null for anything it cannot
 * resolve — unknown or ambiguous options, a missing value — so callers fail
 * closed instead of guessing where the operands start.
 */
function getopt(args: string[], spec: GetoptSpec): GetoptItem[] | null {
  const items: GetoptItem[] = [];
  const longNames = Object.keys(spec.long);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      for (const rest of args.slice(i + 1)) items.push({ kind: "operand", value: rest });
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const raw = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const matches = longNames.filter((name) => name.startsWith(raw));
      const name = longNames.includes(raw) ? raw : matches.length === 1 ? matches[0]! : null;
      if (name === null) return null;
      const arity = spec.long[name]!;
      if (eq !== -1) {
        if (arity === "flag") return null;
        items.push({ kind: "option", name, value: arg.slice(eq + 1) });
      } else if (arity === "value") {
        if (i + 1 >= args.length) return null;
        items.push({ kind: "option", name, value: args[++i]! });
      } else {
        items.push({ kind: "option", name });
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        const letter = arg[j]!;
        const arity = spec.short[letter];
        if (arity === undefined) return null;
        if (arity === "flag") {
          items.push({ kind: "option", name: letter });
          continue;
        }
        const attached = arg.slice(j + 1);
        if (attached || arity === "optional") {
          items.push({ kind: "option", name: letter, ...(attached ? { value: attached } : {}) });
        } else {
          if (i + 1 >= args.length) return null;
          items.push({ kind: "option", name: letter, value: args[++i]! });
        }
        break;
      }
      continue;
    }
    items.push({ kind: "operand", value: arg });
    if (spec.stopAtOperand) {
      for (const rest of args.slice(i + 1)) items.push({ kind: "operand", value: rest });
      break;
    }
  }
  return items;
}

function optionNamed(items: GetoptItem[], names: readonly string[]): GetoptItem | undefined {
  return items.find((item) => item.kind === "option" && names.includes(item.name));
}

const SED_GETOPT: GetoptSpec = {
  short: { n: "flag", r: "flag", E: "flag", s: "flag", u: "flag", z: "flag", b: "flag", e: "value", f: "value", l: "value", i: "optional" },
  long: {
    debug: "flag", expression: "value", file: "value", "follow-symlinks": "flag", help: "flag", "in-place": "optional",
    "line-length": "value", "null-data": "flag", "zero-terminated": "flag", posix: "flag", quiet: "flag", silent: "flag",
    "regexp-extended": "flag", sandbox: "flag", separate: "flag", unbuffered: "flag", version: "flag", binary: "flag",
  },
};

/**
 * Scan a sed script for its write/exec commands: `w`/`W` write a file, `e`
 * runs a command, and the `s///w` / `s///e` flags do the same per
 * substitution. Addresses, regexes, and a/i/c text are parsed rather than
 * pattern-matched, so a `w` inside `/w/p` or `s/a/w/` stays data. Anything the
 * parser does not recognise is reported, never skipped.
 */
function sedScriptWrite(script: string): string | null {
  const s = script;
  const n = s.length;
  let i = 0;
  const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  const skipBlank = () => { while (s[i] === " " || s[i] === "\t") i++; };
  const skipDigits = () => { while (isDigit(s[i])) i++; };
  // Consume a delimiter-terminated part (regex, replacement); false if unterminated.
  const delimited = (delimiter: string): boolean => {
    while (i < n) {
      const c = s[i]!;
      if (c === "\\") { i += 2; continue; }
      if (c === delimiter) { i++; return true; }
      if (c === "\n") return false;
      i++;
    }
    return false;
  };
  // true = parsed an address, false = none here, null = malformed.
  const address = (): boolean | null => {
    const c = s[i];
    if (isDigit(c)) {
      skipDigits();
      if (s[i] === "~") { i++; skipDigits(); }
      return true;
    }
    if (c === "$") { i++; return true; }
    if (c === "/" || c === "\\") {
      const delimiter = c === "/" ? "/" : s[i + 1];
      if (delimiter === undefined || delimiter === "\n" || delimiter === "\\") return null;
      i += c === "/" ? 1 : 2;
      if (!delimited(delimiter)) return null;
      while (s[i] === "I" || s[i] === "M") i++;
      return true;
    }
    return false;
  };

  while (i < n) {
    while (i < n && /[\s;]/.test(s[i]!)) i++;
    if (i >= n) break;
    if (s[i] === "#") {
      while (i < n && s[i] !== "\n") i++;
      continue;
    }
    const first = address();
    if (first === null) return "sed script";
    if (first) {
      skipBlank();
      if (s[i] === ",") {
        i++;
        skipBlank();
        if (s[i] === "+" || s[i] === "~") {
          i++;
          if (!isDigit(s[i])) return "sed script";
          skipDigits();
        } else if (address() !== true) {
          return "sed script";
        }
      }
    }
    skipBlank();
    while (s[i] === "!") { i++; skipBlank(); }
    const command = s[i];
    if (command === undefined) return "sed script";
    i++;
    switch (command) {
      case "{": case "}":
        continue;
      case "=": case "d": case "D": case "g": case "G": case "h": case "H": case "n": case "N":
      case "p": case "P": case "x": case "z": case "F":
        break;
      case "l": case "L": case "q": case "Q":
        skipBlank();
        skipDigits();
        break;
      case "a": case "i": case "c":
        // Text runs to end of line; a backslash continues it onto the next.
        while (i < n && s[i] !== "\n") i += s[i] === "\\" ? 2 : 1;
        continue;
      case ":": case "b": case "t": case "T": case "v":
        while (i < n && s[i] !== "\n" && s[i] !== ";") i++;
        continue;
      case "r": case "R":
        while (i < n && s[i] !== "\n") i++;
        continue;
      case "w": case "W": case "e":
        return `sed ${command}`;
      case "s": case "y": {
        const delimiter = s[i];
        if (delimiter === undefined || delimiter === "\n" || delimiter === "\\") return "sed script";
        i++;
        if (!delimited(delimiter) || !delimited(delimiter)) return "sed script";
        if (command === "s") {
          while (i < n && /[gpiImM0-9]/.test(s[i]!)) i++;
          if (s[i] === "w" || s[i] === "e") return `sed s///${s[i]}`;
        }
        break;
      }
      default:
        return "sed script";
    }
    skipBlank();
    if (i < n && !/[;\n}#]/.test(s[i]!)) return "sed script";
  }
  return null;
}

const SORT_GETOPT: GetoptSpec = {
  short: {
    b: "flag", d: "flag", f: "flag", g: "flag", i: "flag", M: "flag", h: "flag", n: "flag", R: "flag", r: "flag",
    V: "flag", c: "flag", C: "flag", m: "flag", s: "flag", u: "flag", z: "flag",
    k: "value", o: "value", t: "value", S: "value", T: "value",
  },
  long: {
    "ignore-leading-blanks": "flag", "dictionary-order": "flag", "ignore-case": "flag", "general-numeric-sort": "flag",
    "ignore-nonprinting": "flag", "month-sort": "flag", "human-numeric-sort": "flag", "numeric-sort": "flag",
    "random-sort": "flag", "random-source": "value", reverse: "flag", sort: "value", "version-sort": "flag",
    "batch-size": "value", check: "optional", "compress-program": "value", debug: "flag", "files0-from": "value",
    key: "value", merge: "flag", output: "value", stable: "flag", "buffer-size": "value", "field-separator": "value",
    "temporary-directory": "value", parallel: "value", unique: "flag", "zero-terminated": "flag", help: "flag",
    version: "flag",
  },
};

const AWK_GETOPT: GetoptSpec = {
  short: {
    F: "value", v: "value", f: "value", e: "value", i: "value", l: "value", E: "value", W: "value", Z: "value",
    d: "optional", o: "optional", p: "optional", D: "optional", L: "optional",
    b: "flag", c: "flag", C: "flag", g: "flag", h: "flag", M: "flag", n: "flag", N: "flag", O: "flag", P: "flag",
    r: "flag", s: "flag", S: "flag", t: "flag", V: "flag", Y: "flag",
  },
  long: {
    assign: "value", "field-separator": "value", file: "value", source: "value", include: "value", load: "value",
    exec: "value", "dump-variables": "optional", "pretty-print": "optional", profile: "optional", debug: "optional",
    lint: "optional", persist: "optional", "characters-as-bytes": "flag", traditional: "flag", copyright: "flag",
    "gen-pot": "flag", help: "flag", bignum: "flag", "use-lc-numeric": "flag", "non-decimal-data": "flag",
    optimize: "flag", "no-optimize": "flag", posix: "flag", "re-interval": "flag", sandbox: "flag",
    "lint-old": "flag", version: "flag", csv: "flag", trace: "flag",
  },
  stopAtOperand: true,
};

/**
 * Options that load code from a file (unscannable: -f, -i, -l, -E, mawk -W)
 * or write a file of their own (gawk --dump-variables/--pretty-print/--profile
 * default to awkvars.out / awkprof.out).
 */
const AWK_WRITING_OPTIONS = [
  "f", "file", "i", "include", "l", "load", "E", "exec", "W",
  "d", "dump-variables", "o", "pretty-print", "p", "profile",
];
const AWK_REGEX_KEYWORDS = new Set(["print", "printf", "return", "case", "in"]);

/**
 * Scan an awk program for output redirection and command execution. String
 * and regex literals are masked first, so `"a>b|c"` and `/a|b/` stay data and
 * a comparison like `$1 > 200` outside a print statement stays a comparison.
 * An unterminated literal is reported rather than guessed at.
 */
function awkProgramWrite(program: string): string | null {
  let masked = "";
  // A `/` starts a regex where an operand is expected; after an operand it is
  // division. Postfix `++`/`--` end an operand.
  const regexAllowed = (): boolean => {
    const before = masked.replace(/[ \t]+$/, "");
    if (!before) return true;
    const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before);
    if (word) return AWK_REGEX_KEYWORDS.has(word[0]);
    if (/(?:\+\+|--)$/.test(before)) return false;
    return !/[A-Za-z0-9_\])"/.$]$/.test(before);
  };
  for (let i = 0; i < program.length; i++) {
    const c = program[i]!;
    if (c === "#") {
      while (i + 1 < program.length && program[i + 1] !== "\n") i++;
      continue;
    }
    if (c === "\\" && program[i + 1] === "\n") {
      masked += " ";
      i++;
      continue;
    }
    if (c === '"' || (c === "/" && regexAllowed())) {
      let inBracket = false;
      let closed = false;
      for (i++; i < program.length; i++) {
        const d = program[i]!;
        if (d === "\\") { i++; continue; }
        if (d === "\n") break;
        if (c === "/" && d === "[") inBracket = true;
        else if (c === "/" && d === "]") inBracket = false;
        else if (d === c && !inBracket) { closed = true; break; }
      }
      if (!closed) return "awk program";
      masked += c + c;
      continue;
    }
    masked += c;
  }
  const system = /\bsystem\s*\(|\bclose\s*\(/.exec(masked);
  if (system) return system[0];
  // Any single `|` (not `||`) pipes to or from a command: `print | "sh"`,
  // `print | cmd`, `"cmd" | getline`, gawk's `|&` coprocess.
  if (masked.replace(/\|\|/g, "  ").includes("|")) return "awk |";
  for (const print of masked.matchAll(/\bprintf?\b/g)) {
    const statement = /^[^;\n}]*/.exec(masked.slice(print.index))![0];
    if (statement.includes(">")) return `${print[0]} >`;
  }
  // gawk `@`-syntax other than `@namespace` loads code (`@include`, `@load`)
  // or makes an indirect call (`f = "system"; @f("id")`) that the `system(`
  // check above cannot see.
  const directive = /@(?!namespace\b)[A-Za-z_]*/.exec(masked);
  if (directive) return directive[0];
  return null;
}

const awkWrite: ReadOnlyHeadWriteCheck = (args) => {
  const items = getopt(args, AWK_GETOPT);
  if (items === null) return "awk option";
  const writer = optionNamed(items, AWK_WRITING_OPTIONS);
  if (writer?.kind === "option") return `awk -${writer.name.length > 1 ? "-" : ""}${writer.name}`;
  const sources = items.filter((item) => item.kind === "option" && (item.name === "e" || item.name === "source"));
  const program = sources.length > 0
    ? sources.map((item) => (item as { value: string }).value).join("\n")
    : items.find((item) => item.kind === "operand")?.value;
  return program === undefined ? null : awkProgramWrite(program);
};

/** xxd options whose value is the next argv item (by xxd's first-letter dispatch). */
const XXD_VALUE_SPELLINGS = new Set(["-cols", "-groupsize", "-len", "-name", "-seek", "-offset"]);

/** less's own write/exec argv forms, shared by its argv and $LESS. */
function lessArgvWrite(args: readonly string[]): string | null {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg.startsWith("+") && !/^\+\+?(?:\d*[GgFjk]?|[/?].*)$/.test(arg)) return "less +cmd";
    if (/^-[^-]/.test(arg) && /[oO]/.test(arg)) return "less -o";
    // -k/--lesskey-*: a lesskey source can set LESSOPEN in its #env section.
    if (/^-[^-]/.test(arg) && arg.includes("k")) return "less -k";
    const long = /^--([^=]+)/.exec(arg);
    if (long && "log-file".startsWith(long[1]!.toLowerCase())) return "less --log-file";
    if (long && /^lessk/i.test(long[1]!)) return "less --lesskey";
  }
  return null;
}

/**
 * Per-head write/exec detectors for READ_ONLY_HEADS, one predicate per head.
 * These run on every segment BEFORE the safe tier, because a read-only head
 * never reaches the word scan that would otherwise catch its writes.
 */
const READ_ONLY_HEAD_WRITES: Record<string, ReadOnlyHeadWriteCheck> = {
  sed: (args) => {
    const items = getopt(args, SED_GETOPT);
    if (items === null) return "sed option";
    if (optionNamed(items, ["i", "in-place"])) return "sed -i";
    // A script file cannot be inspected from argv.
    if (optionNamed(items, ["f", "file"])) return "sed -f";
    const expressions = items.filter((item) => item.kind === "option" && (item.name === "e" || item.name === "expression"));
    const script = expressions.length > 0
      ? expressions.map((item) => (item as { value: string }).value).join("\n")
      : items.find((item) => item.kind === "operand")?.value;
    return script === undefined ? null : sedScriptWrite(script);
  },
  sort: (args) => {
    const items = getopt(args, SORT_GETOPT);
    if (items === null) return "sort option";
    if (optionNamed(items, ["o", "output"])) return "sort -o";
    if (optionNamed(items, ["compress-program"])) return "sort --compress-program";
    return null;
  },
  awk: awkWrite,
  gawk: awkWrite,
  mawk: awkWrite,
  // xxd writes its second operand (`xxd in out`), and `-r` reverts a dump
  // back into binary. xxd matches options by first letter, so `-revert` is -r.
  xxd: (args) => {
    let i = 0;
    for (; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--") { i++; break; }
      const option = arg.startsWith("--") ? arg.slice(1) : arg;
      if (!option.startsWith("-") || option === "-") break;
      if (option.startsWith("-r")) return "xxd -r";
      if ("cglnosR".includes(option[1]!) && (option.length === 2 || XXD_VALUE_SPELLINGS.has(option))) i++;
    }
    return args.length - i > 1 ? "xxd outfile" : null;
  },
  // --pre runs a preprocessor per file; --hostname-bin runs a program.
  rg: (args) => {
    for (const arg of args) {
      if (arg === "--") break;
      const option = /^--(pre|hostname-bin)(?:=|$)/.exec(arg);
      if (option) return `rg --${option[1]}`;
    }
    return null;
  },
  // -o writes the listing to a file; -R re-runs tree with `-o 00Tree.html` in
  // every directory.
  tree: (args) => {
    for (const arg of args) {
      if (arg === "--") break;
      if (/^-[^-]/.test(arg) && /[oR]/.test(arg)) return "tree -o";
    }
    return null;
  },
  // -exec/-execdir/-ok/-okdir run a command: classify that command in turn
  // (`find -exec grep` still reads). A found file as the command, or any
  // dynamic word (`$VAR`, backticks — re-quoting for the nested classifier
  // would turn them into inert literals), is never read-only. So is an exec
  // with no terminator, unless the missing `;` is an escaped `\;` the segment
  // splitter cut at AND nothing but a separator follows it: otherwise the
  // rest of the find expression (`\; -delete`) was split off unseen.
  find: (args, { inspect, followingText }) => {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (/^-(?:delete|fprint0?|fprintf|fls)$/.test(arg)) return `find ${arg}`;
      if (/^-(?:exec|execdir|ok|okdir)$/.test(arg)) {
        const command: string[] = [];
        let j = i + 1;
        for (; j < args.length; j++) {
          const word = args[j]!;
          // A trailing lone `\` is what is left of `\;` once the segment
          // splitter (which ignores escapes) has cut at the `;`.
          if (word === "\\" && j === args.length - 1) {
            const tail = followingText === null ? null : /^;[ \t]*(?:$|[|&;\n\r])/.exec(followingText);
            if (tail === null) return `find ${arg} \\;`;
            break;
          }
          if (word === ";" || (word === "+" && args[j - 1] === "{}")) break;
          command.push(word);
        }
        if (j >= args.length) return `find ${arg}`;
        if (command.length === 0 || command[0]!.includes("{}") || command.some((word) => /[$`]/.test(word))) {
          return `find ${arg}`;
        }
        const nested = inspect(command);
        if (nested) return nested;
        i = j;
        continue;
      }
      if (/^-(?:exec|ok|fprint|fls)/.test(arg)) return `find ${arg}`;
    }
    return null;
  },
  // -o/-O (clustered or attached) and --log-file/--LOG-FILE, which less
  // accepts abbreviated. `+cmd` runs cmd as an initial command, and less's
  // `!`/`|`/`s` commands exec or write, so only plain positioning/search forms
  // (one line) are allowed. LESSOPEN/LESSCLOSE are input preprocessors
  // (commands) whatever their value, and lesskey sources can set them (and
  // bind keys); $LESS holds options parsed like argv.
  less: (args, { assignments }) => {
    for (const assignment of assignments) {
      const [, name, value] = ENV_ASSIGNMENT_RE.exec(assignment) ?? [];
      if (name === "LESSOPEN" || name === "LESSCLOSE" || name?.startsWith("LESSKEY")) return name;
      if (name === "LESS") {
        // $LESS options may omit the leading dash (`LESS=FRX`).
        const words = value!.split(/\s+/).filter(Boolean).map((word) => /^[-+]/.test(word) ? word : `-${word}`);
        if (lessArgvWrite(words)) return "LESS";
      }
    }
    return lessArgvWrite(args);
  },
  // -i/--inplace rewrites the file; --split-exp writes one file per document.
  yq: (args) => {
    for (const arg of args) {
      if (arg === "--") break;
      if (/^--(?:inplace|in-place|split-exp)(?:=|$)/.test(arg)) return arg.split("=")[0]!;
      if (!/^-[^-]/.test(arg)) continue;
      for (const letter of arg.slice(1)) {
        if (letter === "i" || letter === "s") return `yq -${letter}`;
        // -o/-p/-I take a value; the rest of the cluster is that value.
        if ("opI=".includes(letter)) break;
      }
    }
    return null;
  },
};

/** Quote an argv word for re-classification as shell text. */
function shellQuoteWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./{}-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

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

/** Command-execution APIs are destructive regardless of the command string. */
const NODE_CHILD_PROCESS_RE = /\bchild_process\s*\.\s*(?:exec|execSync|spawn|spawnSync|fork)\s*\(/;
const NODE_REQUIRED_CHILD_PROCESS_RE = /\brequire\s*\(\s*(['"])child_process\1\s*\)\s*\.\s*(?:exec|execSync|spawn|spawnSync|fork)\s*\(/g;
const PYTHON_EXECUTION_RE = /\b(?:os\s*\.\s*(?:system|popen)|subprocess\s*\.\s*(?:run|call|Popen|check_[A-Za-z_][A-Za-z0-9_]*))\s*\(/;
const RUBY_EXECUTION_RE = /\b(?:(?:Kernel\s*\.\s*)?(?:system|exec|spawn)|Open3\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const PERL_EXECUTION_RE = /\b(?:system|exec|readpipe)\b\s*(?:\(|(?=[^A-Za-z0-9_]))/;
const PHP_EXECUTION_RE = /\b(?:system|exec|shell_exec|passthru|proc_open|popen)\s*\(/;

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
export const LANGUAGE_VIEW_CHARACTER_BUDGET = 32 * 1024;
/** Deterministic traversal budget for masking and recursive rescans. */
export const LANGUAGE_VIEW_WORK_BUDGET = 256 * 1024;
/** Keep expensive shared shell inspection off oversized eval payloads. */
export const LANGUAGE_EVAL_EARLY_LIMIT = 16 * 1024;

interface LanguageCall { match: string; args: string | null; }

interface LanguageViewDetails {
  shellBodies: ShellBody[];
}

interface ShellBody {
  body: string;
  language: InterpolationLanguage;
}

interface LanguageSyntaxOptions {
  hashComments: boolean;
  slashComments: boolean;
}

type InterpolationLanguage = "node" | "python" | "ruby" | "perl" | "php";

/** Parse one language backtick/qx body with bounded, quote-aware delimiters. */
function parseShellDelimited(
  source: string,
  openIndex: number,
  end: number,
  open: string,
  close: string,
): { body: string; end: number } | null {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = openIndex + 1; i < end; i++) {
    const ch = source[i]!;
    if (ch === "\\") { i++; continue; }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'") { quote = "'"; continue; }
    if (ch === '"') { quote = '"'; continue; }
    if (open === close && ch === close) {
      return { body: source.slice(openIndex + 1, i), end: i + 1 };
    }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      return { body: source.slice(openIndex + 1, i), end: i + 1 };
    }
  }
  return null;
}

/**
 * Return an offset-preserving view of executable language source. Ordinary
 * strings, alternate literals, heredocs, and comments become spaces, while
 * interpolation bodies are recursively retained because they are executable
 * in JavaScript template strings, Ruby interpolated strings, and Python
 * f-strings. Perl only executes the explicit `${\ ...}`/`@{[ ... ]}` forms.
 * A malformed or over-budget construct returns null (fail closed).
 */
function executableLanguageView(
  source: string,
  language: InterpolationLanguage,
  details?: LanguageViewDetails,
): string | null {
  if (source.length > LANGUAGE_VIEW_CHARACTER_BUDGET) return null;
  const chars = source.split("");
  let work = 0;
  let depth = 0;
  let overBudget = false;
  const charge = (units = 1) => {
    work += units;
    if (work > LANGUAGE_VIEW_WORK_BUDGET) overBudget = true;
    return !overBudget;
  };
  const mask = (start: number, end: number) => {
    charge(Math.max(0, Math.min(end, chars.length) - Math.max(0, start)));
    for (let i = start; i < end && i < chars.length; i++) {
      if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " ";
    }
  };
  const step = () => charge();
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
      if (language === "perl" && ch === "=" && lineStart(i) && /^\s*=(?:pod|head\d*)\b/.test(source.slice(i))) {
        const marker = /(?:^|\r?\n)[ \t]*=cut[ \t]*(?:\r?\n|$)/m.exec(source.slice(i));
        if (!marker) return null;
        const stop = i + marker.index + marker[0].length;
        mask(i, stop); i = stop - 1; continue;
      }
      if (language === "ruby" && lineStart(i) && /^\s*=begin(?:\s|$)/.test(source.slice(i))) {
        const marker = /(?:^|\r?\n)[ \t]*=end(?:[ \t]*)(?:\r?\n|$)/m.exec(source.slice(i));
        if (!marker) return null;
        const stop = i + marker.index + marker[0].length;
        mask(i, stop); i = stop - 1; continue;
      }
      if ((language === "ruby" || language === "perl" || language === "php") && ch === "<" && next === "<") {
        const heredoc = source.slice(i).match(/^<<<?([-~]?)\s*(\\?)(['"]?)([A-Za-z_]\w*)\3[ \t]*;?[ \t]*(?:\r?\n|\r)/);
        if (heredoc) {
          const bodyStart = i + heredoc[0].length;
          const terminator = new RegExp(`(?:^|\\r?\\n)[ \\t]*${heredoc[4]}[ \\t]*;?[ \\t]*(?:\\r?\\n|$)`, "m").exec(source.slice(bodyStart));
          if (!terminator) return null;
          const bodyEnd = bodyStart + terminator.index + terminator[0].length;
          const interpolating = language === "ruby"
            ? heredoc[2] !== "\\" && heredoc[3] !== "'"
            : heredoc[3] !== "'";
          mask(i, bodyStart);
          if (interpolating) {
            const parsed = maskInterpolatedLiteral(bodyStart, bodyEnd, language);
            if (parsed === null) return null;
          } else mask(bodyStart, bodyEnd);
          i = bodyEnd - 1; continue;
        }
      }
      if ((language === "ruby" || language === "perl" || language === "php") && ch === "`") {
        const parsed = parseShellDelimited(source, i, end, "`", "`");
        if (parsed === null) return null;
        details?.shellBodies.push({ body: parsed.body, language });
        mask(i, parsed.end); i = parsed.end - 1; continue;
      }
      if (language === "perl" && ch === "q" && next === "x" &&
        (i === start || !/[A-Za-z0-9_]/.test(source[i - 1]!))) {
        const open = source[i + 2];
        if (!open) return null;
        const close = ({ "{": "}", "[": "]", "(": ")", "<": ">" } as Record<string, string>)[open] ?? open;
        const parsed = parseShellDelimited(source, i + 2, end, open, close);
        if (parsed === null) return null;
        details?.shellBodies.push({ body: parsed.body, language });
        mask(i, parsed.end); i = parsed.end - 1; continue;
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
      if ((lang === "ruby" || lang === "perl" || lang === "php") && ch === "`") {
        const shell = parseShellDelimited(source, i, end, "`", "`");
        if (shell === null) { parsed = null; break; }
        details?.shellBodies.push({ body: shell.body, language: lang });
        mask(i, shell.end); i = shell.end - 1; continue;
      }
      if (lang === "perl" && ch === "q" && next === "x" &&
        (i === start || !/[A-Za-z0-9_]/.test(source[i - 1]!))) {
        const open = source[i + 2];
        if (!open) { parsed = null; break; }
        const close = ({ "{": "}", "[": "]", "(": ")", "<": ">" } as Record<string, string>)[open] ?? open;
        const shell = parseShellDelimited(source, i + 2, end, open, close);
        if (shell === null) { parsed = null; break; }
        details?.shellBodies.push({ body: shell.body, language: lang });
        mask(i, shell.end); i = shell.end - 1; continue;
      }
      if (lang === "ruby" && ch === "%" && /[qQ]/.test(next ?? "")) {
        const stringEnd = parsePercent(i, end);
        if (stringEnd === null) { parsed = null; break; }
        i = stringEnd - 1; continue;
      }
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
      if (language === "ruby" && ch === "%" && /[qQ]/.test(source[i + 1] ?? "")) {
        const nested = parsePercent(i, end);
        if (nested === null) return null;
        i = nested - 1; continue;
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
  return root === null || overBudget ? null : chars.join("");
}

interface ShellInterpolationDetails {
  expressions: string[];
  complete: boolean;
  ambiguous: boolean;
}

/**
 * Extract host-language expressions which are evaluated while a shell literal
 * is rendered. Shell quoting is deliberately ignored here: Ruby/Perl/PHP
 * interpolation happens before the resulting string is handed to the shell.
 */
function extractShellInterpolations(body: string, language: InterpolationLanguage): ShellInterpolationDetails {
  const expressions: string[] = [];
  let complete = true;
  let ambiguous = false;

  const balanced = (start: number, expected: string[]): { value: string; end: number } | null => {
    const stack = [...expected];
    let quote: "'" | '"' | "`" | null = null;
    for (let i = start; i < body.length; i++) {
      const ch = body[i]!;
      if (quote !== null) {
        if (ch === "\\") { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
      if (ch === "(") { stack.push(")"); continue; }
      if (ch === "[") { stack.push("]"); continue; }
      if (ch === "{") { stack.push("}"); continue; }
      if (ch === stack[stack.length - 1]) {
        stack.pop();
        if (stack.length === 0) return { value: body.slice(start, i), end: i + 1 };
      } else if (ch === ")" || ch === "]" || ch === "}") {
        return null;
      }
    }
    return null;
  };

  const escaped = (index: number): boolean => {
    let slashes = 0;
    for (let i = index - 1; i >= 0 && body[i] === "\\"; i--) slashes++;
    return slashes % 2 === 1;
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\") { i++; continue; }
    if (language === "ruby" && body.startsWith("#{", i)) {
      const parsed = balanced(i + 2, ["}"]);
      if (parsed === null) { complete = false; break; }
      expressions.push(parsed.value);
      i = parsed.end - 1;
      continue;
    }
    if (language === "perl" && body.startsWith("${\\", i)) {
      const parsed = balanced(i + 3, ["}"]);
      if (parsed === null) { complete = false; break; }
      expressions.push(parsed.value);
      i = parsed.end - 1;
      continue;
    }
    if (language === "perl" && body.startsWith("@{[", i)) {
      const parsed = balanced(i + 3, ["]", "}"]);
      if (parsed === null) { complete = false; break; }
      expressions.push(parsed.value);
      i = parsed.end - 1;
      continue;
    }
    if (language === "php" && ch === "$" && !escaped(i)) {
      // Backtick strings interpolate PHP variables. A variable's value can
      // introduce arbitrary shell syntax, so only an escaped dollar is
      // unambiguously inert. Braced forms are dynamic as well; their contents
      // are not PHP expressions we can safely evaluate here.
      if (/[A-Za-z_{0-9]/.test(body[i + 1] ?? "")) ambiguous = true;
    }
  }
  return { expressions, complete, ambiguous };
}

interface LanguageScanState {
  depth: number;
  shellBodies: Set<ShellBody>;
  shellBodyCount: number;
}

function scanLanguagePayload(
  payload: string,
  language: InterpolationLanguage,
  state: LanguageScanState,
): string | null {
  if (state.depth >= LANGUAGE_INTERPOLATION_DEPTH_BUDGET) return `${language} eval payload`;
  const details: LanguageViewDetails = { shellBodies: [] };
  const executable = executableLanguageView(payload, language, details);
  if (executable === null) return `${language} eval payload`;
  const execution = findLanguageExecution(payload, executable, language);
  if (execution) return execution;
  for (const shell of details.shellBodies) {
    const nested = scanInterpreterShellBody(shell, state);
    if (nested) return nested;
  }
  if (language === "python") return findPythonWriter(payload);
  if (language === "perl") return findPerlWriter(payload);
  if (language === "ruby") return findRubyWriter(payload);
  if (language === "php") return findPhpWriter(payload);
  return null;
}

function findLanguageExecution(
  payload: string,
  executable: string,
  language: InterpolationLanguage,
): string | null {
  const match = (pattern: RegExp): string | null => {
    pattern.lastIndex = 0;
    return pattern.exec(executable)?.[0]?.trim() ?? null;
  };
  if (language === "node") {
    const direct = match(/\bchild_process\s*\.\s*(?:exec|execSync|spawn|spawnSync|fork)\s*\(/);
    if (direct) return direct;
    for (const required of payload.matchAll(NODE_REQUIRED_CHILD_PROCESS_RE)) {
      const text = required[0]!;
      const method = /(?:exec|execSync|spawn|spawnSync|fork)\s*\(/.exec(text);
      if (!method) continue;
      const methodOffset = required.index! + text.lastIndexOf(method[0]);
      if (executable[methodOffset] !== " ") return method[0].trim();
    }
    // Common aliases are only accepted when their binding is visibly sourced
    // from child_process; an arbitrary `cp.exec()` must remain ordinary code.
    const alias = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"])child_process\2\s*\)/.exec(payload)?.[1];
    if (alias) {
      const aliased = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}\\s*\\.\\s*(?:exec|execSync|spawn|spawnSync|fork)\\s*\\(`);
      return match(aliased);
    }
    const bindings = [
      ...payload.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*(['"])child_process\2\s*\)/g),
      ...payload.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])child_process\2/g),
    ];
    for (const binding of bindings) {
      if (binding.index === undefined || executable[binding.index] === " ") continue;
      for (const part of binding[1]!.split(",")) {
        const pieces = part.trim().split(/\s*(?::|\bas\b)\s*/);
        const local = (pieces[1] ?? pieces[0])?.match(/^[A-Za-z_$][\w$]*/)?.[0];
        if (!local) continue;
        const imported = pieces[0]?.match(/^(?:exec|execSync|spawn|spawnSync|fork)$/)?.[0];
        if (!imported) continue;
        const aliased = new RegExp(`\\b${local.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}\\s*\\(`);
        const call = match(aliased);
        if (call) return call;
      }
    }
    return null;
  }
  if (language === "python") return match(PYTHON_EXECUTION_RE);
  if (language === "ruby") return match(RUBY_EXECUTION_RE);
  if (language === "perl") return match(PERL_EXECUTION_RE);
  return match(PHP_EXECUTION_RE);
}

function scanInterpreterShellBody(shell: ShellBody, state: LanguageScanState): string | null {
  if (state.shellBodies.has(shell)) return null;
  if (++state.shellBodyCount > LANGUAGE_CALL_CANDIDATE_BUDGET || state.depth >= LANGUAGE_INTERPOLATION_DEPTH_BUDGET) {
    return `${shell.language} shell body`;
  }
  state.shellBodies.add(shell);
  const interpolation = extractShellInterpolations(shell.body, shell.language);
  if (!interpolation.complete || interpolation.ambiguous) return `${shell.language} shell interpolation`;
  const previousDepth = state.depth;
  state.depth++;
  for (const expression of interpolation.expressions) {
    const nested = scanLanguagePayload(expression, shell.language, state);
    if (nested) { state.depth = previousDepth; return nested; }
  }
  state.depth = previousDepth;
  // The host expression scan and shell scan are separate by design: direct
  // shell redirects/mutations remain visible even when host interpolation is
  // otherwise harmless.
  const shellMutation = findDestructiveTokenInternal(shell.body, state.depth + 1);
  return shellMutation ? `shell ${shellMutation}` : null;
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

type EvalPrograms =
  | { kind: "none" }
  | { kind: "eval"; programs: string[]; join: boolean }
  | { kind: "violation"; reason: string };

/** Modules a `perl -M`/`-m` or `ruby -r` preload may name: loading them runs no repo code. */
const PERL_PRELOAD_MODULES = new Set(["strict", "warnings", "utf8", "JSON::PP", "Data::Dumper", "List::Util"]);
const RUBY_PRELOAD_LIBRARIES = new Set(["json", "set", "pp", "yaml"]);
/** Node options that load code before the eval program runs. */
const NODE_PRELOAD_OPTION_RE =
  /^(?:-r|--require|--import|--loader|--experimental-loader|--preload|--env-file|--env-file-if-exists|--experimental-config-file|--experimental-default-config-file)(?:=|$)/;

/**
 * Environment variables that make an interpreter load code or options before
 * the eval program (`NODE_OPTIONS='"--require" x'`, `PERL5OPT=-Mevil`, an ini
 * `auto_prepend_file` via PHPRC). Any value is refused: their parsers (quote
 * stripping, option splicing) are not worth re-implementing to find a safe one.
 */
const INTERPRETER_PRELOAD_ENV: Record<string, ReadonlySet<string>> = {
  node: new Set(["NODE_OPTIONS"]),
  bun: new Set(["NODE_OPTIONS", "BUN_OPTIONS"]),
  deno: new Set(["NODE_OPTIONS", "DENO_OPTIONS"]),
  perl: new Set(["PERL5OPT", "PERL5LIB", "PERLLIB"]),
  ruby: new Set(["RUBYOPT", "RUBYLIB"]),
  php: new Set(["PHPRC", "PHP_INI_SCAN_DIR"]),
  python: new Set(["PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME"]),
  python3: new Set(["PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME"]),
};

/**
 * The inline programs of an interpreter invocation, parsed with each
 * interpreter's own option grammar, without the script arguments that follow
 * (`perl -pe 's/a/b/' FILE`). Clustered switches (`python3 -Ic`, `perl -lane`,
 * `ruby -ne`), attached programs (`-ePROGRAM`, `--eval=PROGRAM`) and repeated
 * eval flags are all collected. Options that load code before the program
 * (`node -r`, `perl -Mmod`, `ruby -rlib`, `php -d`) and options the grammar
 * does not know are violations: an extraction miss must never degrade to "no
 * calls". `none` means the invocation runs a script or nothing inline.
 */
function interpreterEvalPrograms(segment: string): EvalPrograms {
  const normalized = normalizeEnvInvocation(shellWords(segment));
  if (!normalized.complete || normalized.argv.length === 0) return { kind: "violation", reason: "ambiguous invocation" };
  const head = normalized.argv[0]!.replace(/^.*\//, "");
  const argv = normalized.argv;
  const programs: string[] = [];
  const violation = (reason: string): EvalPrograms => ({ kind: "violation", reason });
  const result = (join: boolean): EvalPrograms => programs.length > 0 ? { kind: "eval", programs, join } : { kind: "none" };

  const preloadEnv = INTERPRETER_PRELOAD_ENV[head];
  for (const assignment of normalized.assignments) {
    const name = ENV_ASSIGNMENT_RE.exec(assignment)?.[1];
    if (name && preloadEnv?.has(name)) return violation(name);
  }

  if (head === "deno") {
    return argv[1] === "eval" || argv[1] === "run" ? violation(`deno ${argv[1]}`) : { kind: "none" };
  }

  if (head === "python" || head === "python3") {
    for (let i = 1; i < argv.length; i++) {
      const word = argv[i]!;
      if (word === "--" || word === "-" || !word.startsWith("-")) return { kind: "none" };
      if (word.startsWith("--")) {
        if (/^--(?:version|help)$/.test(word)) continue;
        return violation(word);
      }
      for (let j = 1; j < word.length; j++) {
        const letter = word[j]!;
        if (letter === "c") {
          const rest = word.slice(j + 1);
          if (rest) programs.push(rest);
          else if (i + 1 < argv.length) programs.push(argv[++i]!);
          else return violation("-c");
          return result(false);
        }
        if (letter === "m") return { kind: "none" };
        if (letter === "W" || letter === "X") {
          if (j === word.length - 1) i++;
          break;
        }
        if (!"bBdEhiIOPqsSuvVxR".includes(letter)) return violation(`-${letter}`);
      }
    }
    return { kind: "none" };
  }

  if (head === "perl" || head === "ruby") {
    const isPerl = head === "perl";
    // Per-letter grammar, audited against perl.c/perlrun and ruby.c:
    // - plain switches continue the cluster;
    // - digit-suffixed ones (`-0777`, `-l`, `-CSD`, `-W0`) consume only
    //   their own characters;
    // - attach-only switches (perl -F/-i/-M/-m/-x, ruby -F/-i/-x) take the
    //   rest of the cluster and NEVER the next word, and ruby -K takes one
    //   character and continues;
    // - only perl -e/-E/-I and ruby -e/-E/-r/-I/-C may take the next word.
    const plain = isPerl ? "napsuUtTwWXcvhfgS" : "napslvwdcyUh";
    const digits: Record<string, RegExp> = isPerl
      ? { l: /^[0-7]*/, "0": /^(?:x[0-9a-fA-F]*|[0-7]*)/, C: /^(?:\d+|[IOEioSDAL]*)/ }
      : { "0": /^[0-7]*/, W: /^[0-2:a-z]*/, K: /^[a-zA-Z]?/ };
    const separate = isPerl ? "eEI" : "eErIC";
    const attachOnly = isPerl ? "FiMmx" : "Fix";
    for (let i = 1; i < argv.length; i++) {
      const word = argv[i]!;
      if (word === "--" || word === "-" || !word.startsWith("-")) break;
      if (word.startsWith("--")) {
        if (/^--(?:version|help|verbose|disable-gems|disable=gems)$/.test(word)) continue;
        return violation(word);
      }
      for (let j = 1; j < word.length; j++) {
        const letter = word[j]!;
        if (plain.includes(letter)) continue;
        const digitRe = digits[letter];
        if (digitRe) {
          j += digitRe.exec(word.slice(j + 1))![0].length;
          continue;
        }
        let value = word.slice(j + 1);
        if (separate.includes(letter)) {
          if (!value) {
            if (i + 1 >= argv.length) return violation(`-${letter}`);
            value = argv[++i]!;
            // A switch value spelled like an option means the words were
            // not paired the way we think; fail closed.
            if (value.startsWith("-") && letter !== "e" && letter !== "E") return violation(`-${letter} ${value}`);
          } else if ((letter === "e" || letter === "E") && j === 1) {
            value = attachedEvalProgram(segment, head as "perl" | "ruby") ?? value;
          }
        } else if (!attachOnly.includes(letter)) {
          return violation(`-${letter}`);
        }
        if (letter === "e" || letter === "E") programs.push(value);
        else if (isPerl && (letter === "M" || letter === "m")) {
          // perl splices the whole value into `use …;`, so it must be exactly
          // a reader module name with an optional `=import,list`.
          const spec = /^([A-Za-z_][\w:]*)(?:=[\w,:]*)?$/.exec(value);
          if (!spec || !PERL_PRELOAD_MODULES.has(spec[1]!)) return violation(`-${letter}${value}`);
        } else if (!isPerl && letter === "r") {
          if (!RUBY_PRELOAD_LIBRARIES.has(value)) return violation(`-r${value}`);
        } else if (!isPerl && letter === "x") {
          return violation("-x");
        }
        break;
      }
    }
    return result(true);
  }

  if (head === "php") {
    for (let i = 1; i < argv.length; i++) {
      const word = argv[i]!;
      if (word === "--" || !word.startsWith("-")) break;
      const program = /^(?:-[rBRE]|--(?:run|process-begin|process-code|process-end))$/.test(word);
      if (program) {
        if (i + 1 >= argv.length) return violation(word);
        programs.push(argv[++i]!);
        continue;
      }
      if (/^-[nqHhviem]+$/.test(word)) continue;
      return violation(word);
    }
    return result(false);
  }

  // node and bun: options may follow the program, a later `--eval=` replaces
  // an earlier one, and an unknown option may take a separate value, so every
  // eval flag anywhere in argv is collected (a script argument spelled like
  // one fails closed).
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === "--") break;
    if (!word.startsWith("-")) continue;
    if (NODE_PRELOAD_OPTION_RE.test(word)) return violation(word.replace(/=.*$/s, ""));
    const attached = /^--(?:eval|print)=(.*)$/s.exec(word);
    if (attached) {
      programs.push(attached[1]!);
      continue;
    }
    if (/^(?:-e|-p|-pe|-ep|--eval|--print)$/.test(word)) {
      if (i + 1 >= argv.length) return violation(word);
      programs.push(argv[++i]!);
    }
  }
  return result(false);
}

function interpreterEvalPayload(segment: string): string {
  const words = shellWords(segment);
  const normalized = normalizeEnvInvocation(words);
  if (!normalized.complete || normalized.argv.length === 0) return segment;
  const head = normalized.argv[0]!.replace(/^.*\//, "");
  const evalFlag = /^(?:--eval|--print|--run|-r|-[epnc]|-[pn]*e[pn]*)$/;
  const index = normalized.argv.findIndex((word, i) => i > 0 && evalFlag.test(word));
  if (index >= 0) return normalized.argv.slice(index + 1).join(" ");
  // Ruby and Perl accept an eval program attached directly to `-e`, e.g.
  // `ruby -eFile.write(...)`. Keep this narrow: other interpreters have
  // materially different short-option grammars and remain fail-closed below.
  if (head === "ruby" || head === "perl") {
    const attached = normalized.argv.findIndex((word, i) => i > 0 && /^-e.+/.test(word));
    if (attached >= 0) {
      const raw = attachedEvalProgram(segment, head);
      return raw ?? [normalized.argv[attached]!.slice(2), ...normalized.argv.slice(attached + 1)].join(" ");
    }
  }
  return segment;
}

/**
 * Extract an attached Ruby/Perl `-ePROGRAM` while retaining quotes that are
 * part of PROGRAM. ShellWords must remove the shell's outer argument quotes,
 * but attached programs can also use those same delimiters as language
 * string syntax (for example `-eputs("File.write('x','y')")`). A quote that
 * starts before any program text is an outer shell wrapper; quotes encountered
 * after text has started are retained as language syntax.
 */
function attachedEvalProgram(segment: string, interpreter: "ruby" | "perl"): string | null {
  const match = new RegExp(`(?:^|\\s)(?:[^\\s]*\\/)?${interpreter}\\s+(-e)`).exec(segment);
  if (!match) return null;
  const tokenStart = match.index + match[0]!.indexOf(match[1]!);
  let tokenEnd = tokenStart + match[1]!.length;
  let shellQuote: "'" | '"' | null = null;
  let shellEscaped = false;
  for (; tokenEnd < segment.length; tokenEnd++) {
    const ch = segment[tokenEnd]!;
    if (shellEscaped) { shellEscaped = false; continue; }
    if (ch === "\\" && shellQuote !== "'") { shellEscaped = true; continue; }
    if (shellQuote !== null) {
      if (ch === shellQuote) shellQuote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { shellQuote = ch; continue; }
    if (/\s/.test(ch)) break;
  }
  if (shellQuote !== null || shellEscaped) return null;
  const raw = segment.slice(tokenStart + match[1]!.length, tokenEnd);
  let program = "";
  let quote: "'" | '"' | null = null;
  let preserveQuote = false;
  let escaped = false;
  for (const ch of raw) {
    if (escaped) {
      program += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        if (preserveQuote) program += ch;
        quote = null;
      } else {
        program += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      preserveQuote = program.length > 0;
      if (preserveQuote) program += ch;
      quote = ch;
      continue;
    }
    program += ch;
  }
  if (escaped || quote !== null) return null;
  return program;
}

function interpreterLanguage(head: string): InterpolationLanguage {
  if (head === "node" || head === "deno" || head === "bun") return "node";
  if (head === "python3") return "python";
  return head as InterpolationLanguage;
}

/**
 * Cheap argv-aware eval preflight. It intentionally uses the same quote-aware
 * shell word splitter as payload extraction, but does not inspect substitutions
 * or language syntax. A null result means this command is not a direct eval
 * invocation; callers can then proceed with ordinary shell classification.
 */
function directInterpreterEvalPreflight(segment: string): { payloadLength: number; interpreter: string } | null {
  const words = shellWords(segment);
  const normalized = normalizeEnvInvocation(words);
  if (!normalized.complete || normalized.argv.length === 0) return null;
  const interpreter = normalized.argv[0]!.replace(/^.*\//, "");
  if (!EVAL_INTERPRETERS.has(interpreter)) return null;
  const evalFlag = /^(?:--eval|--print|--run|-r|-[epnc]|-[pn]*e[pn]*)$/;
  let flagIndex = normalized.argv.findIndex((word, i) => i > 0 && evalFlag.test(word));
  if (flagIndex < 0 && (interpreter === "ruby" || interpreter === "perl")) {
    flagIndex = normalized.argv.findIndex((word, i) => i > 0 && /^-e.+/.test(word));
    if (flagIndex >= 0) {
      return { interpreter, payloadLength: [normalized.argv[flagIndex]!.slice(2), ...normalized.argv.slice(flagIndex + 1)].join(" ").length };
    }
  }
  if (flagIndex < 0) return null;
  return { interpreter, payloadLength: normalized.argv.slice(flagIndex + 1).join(" ").length };
}

function stripShellControlPrefix(fragment: string): string {
  let current = fragment.trim();
  for (let i = 0; i < 8; i++) {
    const next = current.replace(/^(?:(?:if|then|elif|else|fi|while|until|do|done|for|select|function|coproc)\b|[!{}()])\s*/u, "");
    if (next === current) break;
    current = next;
  }
  return current;
}

interface CheapScanBudget { remaining: number; exhausted: boolean; }

function chargeCheapScan(budget: CheapScanBudget): boolean {
  if (budget.remaining <= 0) {
    budget.exhausted = true;
    return false;
  }
  budget.remaining--;
  return true;
}

function cheapGroupClose(
  command: string,
  start: number,
  open: string,
  close: string,
  budget: CheapScanBudget,
): number {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = start + 1; i < command.length; i++) {
    if (!chargeCheapScan(budget)) return -2;
    const ch = command[i]!;
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (quote === '"') {
      if (ch === "\\") {
        if (i + 1 < command.length && !chargeCheapScan(budget)) return -2;
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < command.length && !chargeCheapScan(budget)) return -2;
      i++;
      continue;
    }
    if (ch === "'") { quote = "'"; continue; }
    if (ch === '"') { quote = '"'; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

/**
 * Lightweight command-fragment extraction for the eval-size guard. This is
 * intentionally not the shared shell parser: it only tracks quotes, joins,
 * and substitution/group delimiters, then delegates argv interpretation to
 * the existing direct preflight. Its bounded recursion keeps oversized evals
 * out of the more expensive executable-body tree.
 */
function cheapInterpreterFragments(
  command: string,
  depth = 0,
  budget: CheapScanBudget = { remaining: LANGUAGE_EVAL_EARLY_LIMIT * 8, exhausted: false },
): string[] | null {
  if (depth > 16 || budget.exhausted || command.length > budget.remaining) {
    budget.exhausted = true;
    return null;
  }
  budget.remaining -= command.length;
  const fragments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  const isCaseCommand = /^\s*case\b[\s\S]*\bin\b/u.test(command);
  for (let i = 0; i < command.length; i++) {
    if (!chargeCheapScan(budget)) return null;
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        if (i + 1 < command.length && !chargeCheapScan(budget)) return null;
        i++;
        continue;
      }
      if (ch === '"') { quote = null; continue; }
      continue;
    } else if (ch === "\\") {
      if (i + 1 < command.length && !chargeCheapScan(budget)) return null;
      i++;
      continue;
    } else if (ch === "'") {
      quote = "'";
      continue;
    } else if (ch === '"') {
      quote = '"';
      continue;
    }

    const substitution = (ch === "$" || ch === "<" || ch === ">") && command[i + 1] === "(";
    if (substitution) {
      const bodyStart = i + 2;
      let parens = 1;
      let innerQuote: "'" | '"' | null = null;
      let close = -1;
      for (let j = bodyStart; j < command.length; j++) {
        if (!chargeCheapScan(budget)) return null;
        const inner = command[j]!;
        if (innerQuote === "'") { if (inner === "'") innerQuote = null; continue; }
        if (innerQuote === '"') {
          if (inner === "\\") {
            if (j + 1 < command.length && !chargeCheapScan(budget)) return null;
            j++;
            continue;
          }
          if (inner === '"') innerQuote = null;
          continue;
        }
        if (inner === "\\") {
          if (j + 1 < command.length && !chargeCheapScan(budget)) return null;
          j++;
          continue;
        }
        if (inner === "'") { innerQuote = "'"; continue; }
        if (inner === '"') { innerQuote = '"'; continue; }
        if (inner === "(") parens++;
        else if (inner === ")" && --parens === 0) { close = j; break; }
      }
      if (close >= 0) {
        const nested = cheapInterpreterFragments(command.slice(bodyStart, close), depth + 1, budget);
        if (nested === null) return null;
        fragments.push(...nested);
        i = close;
      }
      continue;
    }
    if (ch === "(" || ch === "{") {
      const close = cheapGroupClose(command, i, ch, ch === "(" ? ")" : "}", budget);
      if (close === -2) return null;
      if (close >= 0) {
        const nested = cheapInterpreterFragments(command.slice(i + 1, close), depth + 1, budget);
        if (nested === null) return null;
        fragments.push(...nested);
        i = close;
      }
      continue;
    }
    if (ch === "`") {
      let close = -1;
      for (let j = i + 1; j < command.length; j++) {
        if (!chargeCheapScan(budget)) return null;
        if (command[j] === "\\") {
          if (j + 1 < command.length && !chargeCheapScan(budget)) return null;
          j++;
          continue;
        }
        if (command[j] === "`") { close = j; break; }
      }
      if (close >= 0) {
        const nested = cheapInterpreterFragments(command.slice(i + 1, close), depth + 1, budget);
        if (nested === null) return null;
        fragments.push(...nested);
        i = close;
      }
      continue;
    }
    // A case arm starts after its unquoted `pattern)` delimiter rather than
    // after a command separator. Expose that arm as a fresh command fragment
    // while leaving ordinary parenthesized groups to the branch above.
    if (ch === ")" && isCaseCommand) {
      start = i + 1;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "&" || ch === "\n" || ch === "\r") {
      if (command.slice(start, i).trim()) fragments.push(command.slice(start, i));
      start = i + 1;
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
      if (ch === "\r" && command[i + 1] === "\n") i++;
    }
  }
  if (command.slice(start).trim()) fragments.push(command.slice(start));
  return fragments;
}

export function interpreterEvalPreflight(segment: string): { payloadLength: number; interpreter: string } | null {
  const direct = directInterpreterEvalPreflight(segment);
  if (direct) return direct;
  const fragments = cheapInterpreterFragments(segment);
  if (fragments === null) return { interpreter: "shell", payloadLength: LANGUAGE_EVAL_EARLY_LIMIT + 1 };
  for (const fragment of fragments) {
    const candidate = directInterpreterEvalPreflight(stripShellControlPrefix(fragment));
    if (candidate) return candidate;
  }
  return null;
}

function languageWordScanSegment(head: string, segment: string): string {
  if (!isEvalInvocation(head, segment) || !EVAL_INTERPRETERS.has(head)) return segment;
  const payload = interpreterEvalPayload(segment);
  const language = interpreterLanguage(head);
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
 * Interpreter eval payloads are mutating UNLESS every call they make is on a
 * small per-language reader allowlist (CORE-5). The writer/exec screens above
 * still run first, so their mode checks (`open(f, "w")`, Perl `sysopen` flags,
 * Ruby `File.open` modes) stay authoritative for the reader calls listed here.
 *
 * `calls` holds full dotted call chains (`::`, `->` and `?.` normalized to
 * `.`); a trailing `.*` admits every member of that root. `valueMethods` are
 * the pure methods allowed on a computed receiver (`open(f).read()`,
 * `"a,b".split(",")`). `roots` are names whose rebinding (`print = os.remove`)
 * would turn an allowlisted call into something else, so any assignment to or
 * declaration of them fails closed.
 */
interface ReaderAllowlist {
  calls: ReadonlySet<string>;
  valueMethods: ReadonlySet<string>;
  keywords: ReadonlySet<string>;
  roots: ReadonlySet<string>;
  /** Identifiers that reach reflection/global state; any mention fails closed. */
  forbidden: RegExp;
}

/**
 * Exact `os`/`sys` members a Python reader may touch, called or not. No
 * wildcard: `os.path.os` and `sys.modules` lead straight back to writers.
 */
const PYTHON_OS_SYS_READERS = [
  ...[
    "exists", "isfile", "isdir", "islink", "isabs", "join", "basename", "dirname", "abspath", "realpath", "getsize",
    "getmtime", "getctime", "getatime", "splitext", "split", "normpath", "relpath", "expanduser", "expandvars",
    "commonpath", "sep",
  ].map((name) => `os.path.${name}`),
  "os.path", "os.listdir", "os.getcwd", "os.getenv", "os.environ", "os.environ.get", "os.sep", "os.linesep",
  "os.name", "os.curdir",
  "sys.argv", "sys.version", "sys.version_info", "sys.version_info.major", "sys.version_info.minor",
  "sys.platform", "sys.executable", "sys.maxsize", "sys.byteorder", "sys.path", "sys.stdin", "sys.stdin.read",
  "sys.stdin.readline", "sys.stdin.readlines", "sys.stdout", "sys.stdout.write", "sys.stderr", "sys.stderr.write",
  "sys.exit",
];

/** Stdlib modules a Python reader may import; importing anything else runs its code. */
const PYTHON_IMPORTABLE = new Set([
  "json", "sys", "os", "os.path", "re", "math", "datetime", "hashlib", "base64", "platform", "struct", "string",
  "textwrap", "collections", "itertools", "functools", "pprint", "csv", "tomllib", "time", "statistics", "decimal",
  "fractions", "pathlib",
]);

/**
 * Member names a one-level `X.*` wildcard never admits: attributes that
 * re-expose another module (`platform.os`, `re.sys`) lead back to writers.
 */
const WILDCARD_EXCLUDED_MEMBERS = new Set([
  "os", "sys", "subprocess", "shutil", "importlib", "builtins", "ctypes", "socket", "io", "codecs", "posix", "nt",
  "pathlib", "tempfile", "signal", "constructor", "prototype",
]);

const READER_ALLOWLISTS: Record<InterpolationLanguage, ReaderAllowlist> = {
  python: {
    calls: new Set([
      "print", "open", "json.load", "json.loads", "json.dump", "json.dumps", ...PYTHON_OS_SYS_READERS,
      "len", "str", "int", "float", "bool", "repr", "sorted", "list", "dict", "tuple", "set",
      "min", "max", "sum", "abs", "round", "range", "enumerate", "zip", "isinstance", "hex", "oct", "bin", "chr",
      "ord", "any", "all", "map", "filter", "reversed", "type", "hash", "divmod", "pow", "format", "iter", "next",
      "math.*", "re.*", "hashlib.*", "base64.*", "struct.*", "statistics.*", "textwrap.*", "collections.*",
      "itertools.*", "functools.*", "string.*", "time.time", "time.monotonic", "datetime.datetime.now",
      "datetime.datetime.utcnow", "datetime.datetime.fromtimestamp", "datetime.date.today", "csv.reader",
      "tomllib.load", "tomllib.loads", "pprint.pprint", "decimal.Decimal", "fractions.Fraction",
      "platform.python_version", "platform.system", "platform.machine", "platform.release", "platform.platform",
      "platform.node", "platform.python_implementation",
    ]),
    valueMethods: new Set([
      "read", "readline", "readlines", "strip", "lstrip", "rstrip", "split", "splitlines", "get", "keys", "values",
      "items", "join", "format", "lower", "upper", "startswith", "endswith", "count", "find", "hexdigest", "digest",
      "decode", "encode", "isoformat", "strftime", "group", "groups",
    ]),
    keywords: new Set([
      "if", "elif", "while", "for", "in", "not", "and", "or", "is", "return", "lambda", "else", "assert", "yield", "del",
      "with", "as", "except",
    ]),
    roots: new Set([
      "print", "open", "json", "sys", "os", "len", "str", "int", "float", "bool", "repr", "sorted", "list", "dict",
      "tuple", "set", "min", "max", "sum", "abs", "round", "range", "enumerate", "zip", "isinstance",
    ]),
    forbidden: /\b(?:__builtins__|builtins|__dict__|__class__|__globals__|__subclasses__|__getattribute__|__code__|__import__|__loader__|__spec__|exec|eval|compile|getattr|setattr|delattr|globals|locals|vars|breakpoint|modules|_getframe|meta_path|path_hooks)\b/,
  },
  node: {
    calls: new Set([
      "console.log", "console.error", "process.stdout.write", "process.stderr.write", "require", "JSON.*",
      "fs.readFileSync", "fs.existsSync", "fs.readdirSync",
      "fs.statSync", "Object.keys", "Object.values", "Object.entries", "String", "Number", "parseInt", "parseFloat",
      "Math.*", "Date", "Date.now", "Array.isArray", "Array.from", "Number.isInteger",
    ]),
    valueMethods: new Set([
      "toString", "trim", "split", "join", "slice", "map", "filter", "includes", "startsWith", "endsWith",
      "toUpperCase", "toLowerCase", "indexOf", "toFixed", "at", "find", "some", "every", "forEach", "repeat",
      "reduce", "toISOString", "getTime", "padStart", "padEnd",
    ]),
    keywords: new Set(["if", "while", "for", "switch", "catch", "return", "typeof", "function", "await", "void", "in", "of", "delete"]),
    roots: new Set(["console", "require", "JSON", "fs", "Object", "String", "Number", "parseInt", "parseFloat"]),
    forbidden: /(?<![\w$])(?:globalThis|global|window|self|Reflect|Proxy|__proto__|prototype|constructor|defineProperty|module|import|eval|Function)(?![\w$])/,
  },
  ruby: {
    calls: new Set([
      "puts", "print", "File.read", "File.readlines", "File.open", "File.exist?", "File.file?", "File.directory?",
      "Dir.glob", "Dir.entries", "JSON.parse", "require", "FileUtils.pwd",
      "FileUtils.compare_file", "FileUtils.identical?", "FileUtils.cmp", "FileUtils.uptodate?",
    ]),
    valueMethods: new Set([
      "puts", "print", "read", "each", "each_line", "map", "select", "size", "length", "keys", "values", "strip",
      "chomp", "split", "join", "to_s", "to_i", "first", "last", "lines", "upcase", "downcase", "sort", "count",
      "include?", "start_with?", "end_with?", "fetch", "inspect",
    ]),
    keywords: new Set([
      "if", "unless", "else", "elsif", "end", "do", "while", "until", "for", "in", "and", "or", "not", "then",
      "case", "when", "nil", "true", "false", "self", "return", "next", "break", "begin", "rescue", "ensure",
    ]),
    roots: new Set(),
    forbidden: /\b(?:alias|define_method|send|public_send|__send__|instance_eval|class_eval|binding|ObjectSpace)\b/,
  },
  perl: {
    calls: new Set([
      "print", "printf", "say", "open", "sysopen", "close", "chomp", "chop", "lc", "uc", "length", "substr", "index",
      "join", "split", "sprintf", "sort", "reverse", "keys", "values", "each", "exists", "defined", "scalar", "map",
      "grep", "abs", "int", "chr", "ord", "binmode", "eof", "use", "strict", "warnings", "Fcntl",
    ]),
    valueMethods: new Set(),
    keywords: new Set([
      "my", "our", "local", "if", "unless", "else", "elsif", "while", "until", "for", "foreach", "last", "next",
      "return", "and", "or", "not", "eq", "ne", "lt", "gt", "le", "ge", "cmp", "x",
    ]),
    roots: new Set(),
    forbidden: /\b(?:CORE|GLOBAL)\b/,
  },
  php: {
    calls: new Set([
      "echo", "print", "var_dump", "print_r", "file_get_contents", "json_decode", "json_encode", "fopen", "fgets",
      "fread", "fclose", "file_exists", "is_file", "is_dir", "scandir", "strlen", "count", "implode", "explode", "trim",
      "getcwd", "phpversion",
    ]),
    valueMethods: new Set(),
    keywords: new Set(["if", "elseif", "while", "for", "foreach", "switch", "array", "isset", "empty", "list", "return", "function", "echo", "print"]),
    roots: new Set(),
    forbidden: /\$\$|\b(?:call_user_func|call_user_func_array|create_function|include|include_once|require|require_once|eval|assert)\b/i,
  },
};

/**
 * Exact chains, or `X.*`, which admits exactly one further public member of X
 * that does not re-expose a module (`math.sqrt`, never `platform.os.system`).
 */
function allowlistedCall(chain: string, allowlist: ReaderAllowlist): boolean {
  if (allowlist.calls.has(chain)) return true;
  const dot = chain.lastIndexOf(".");
  if (dot === -1 || !allowlist.calls.has(`${chain.slice(0, dot)}.*`)) return false;
  const member = chain.slice(dot + 1);
  return !member.startsWith("_") && !WILDCARD_EXCLUDED_MEMBERS.has(member);
}

/** Node `require` is a reader only for relative JSON files and `fs` itself. */
function nodeRequireArgument(args: string | null): "json" | "fs" | null {
  const literal = /^\s*(['"])([^'"\\]*)\1\s*$/.exec(args ?? "");
  if (!literal) return null;
  if (literal[2] === "fs" || literal[2] === "node:fs") return "fs";
  return /^\.{1,2}\/[^]*\.json$/.test(literal[2]!) ? "json" : null;
}

/**
 * The identifier ending at `end` (inclusive), scanned backwards. A `$`-anchored
 * regex over the prefix would retry from every position of a long identifier.
 */
function trailingWord(view: string, end: number): string | undefined {
  let start = end;
  while (start >= 0 && /\w/.test(view[start]!)) start--;
  const word = view.slice(start + 1, end + 1);
  return /^[A-Za-z_]/.test(word) ? word : undefined;
}

/** Names bound by `for NAMES in` (bounded, single-pass per `for`). */
function forLoopTargets(view: string): string[] {
  const names: string[] = [];
  for (const match of view.matchAll(/\bfor\s/g)) {
    const rest = view.slice(match.index! + match[0].length, match.index! + match[0].length + 256);
    const target = /\sin\b/.exec(rest);
    if (target) names.push(...namesIn(rest.slice(0, target.index)));
  }
  return names;
}

function skipBackSpaces(view: string, index: number): number {
  let i = index;
  while (i >= 0 && /\s/.test(view[i]!)) i--;
  return i;
}

/**
 * Mask Perl/Ruby regex and substitution literals in an executable view, so
 * `print if /foo/` does not read `foo` as a bareword call. Perl's `s///e`
 * evaluates its replacement as code and is returned as a violation.
 */
function maskRegexLiterals(source: string, view: string, language: "ruby" | "perl"): { view: string; violation: string | null } {
  const chars = view.split("");
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]", "<": ">" };
  const operandContext = (i: number): boolean => {
    const before = skipBackSpaces(view, i - 1);
    if (before < 0) return true;
    if (/[(,=~!{;&|?:]/.test(view[before]!)) return true;
    const word = trailingWord(view, before);
    return word !== undefined && /^(?:if|unless|and|or|not|split|grep|return|when|while|until)$/.test(word);
  };
  const scanDelimited = (start: number, open: string): number => {
    const close = pairs[open] ?? open;
    let depth = 1;
    for (let i = start; i < source.length; i++) {
      const ch = source[i]!;
      if (ch === "\\") { i++; continue; }
      if (open !== close && ch === open) depth++;
      else if (ch === close && --depth === 0) return i;
    }
    return -1;
  };
  for (let i = 0; i < view.length; i++) {
    const ch = view[i]!;
    let quoted: RegExpExecArray | null = null;
    if (language === "perl" && /[msqyt]/.test(ch) && (i === 0 || !/[\w$@%&>:]/.test(view[i - 1]!))) {
      quoted = /^(?:tr|s|m|qr|y)\s*([^\w\s])/.exec(view.slice(i, i + 8));
    }
    if (language === "ruby" && ch === "%" && view[i + 1] === "r") quoted = /^%r([^\w\s])/.exec(view.slice(i, i + 3));
    let start: number;
    let open: string;
    let parts: number;
    let op = "";
    if (quoted) {
      op = quoted[0].slice(0, quoted[0].length - 1).trim();
      open = quoted[1]!;
      start = i + quoted[0].length;
      parts = op === "s" || op === "tr" || op === "y" ? 2 : 1;
    } else if (ch === "/" && operandContext(i)) {
      open = "/";
      start = i + 1;
      parts = 1;
    } else continue;
    let end = scanDelimited(start, open);
    if (end === -1) return { view, violation: `${language} regex literal` };
    if (parts === 2) {
      let next = end + 1;
      let secondOpen = open;
      if (pairs[open]) {
        while (/\s/.test(source[next] ?? "")) next++;
        secondOpen = source[next] ?? "";
        next++;
      }
      end = scanDelimited(next, secondOpen);
      if (end === -1) return { view, violation: `${language} regex literal` };
    }
    let flagsEnd = end + 1;
    while (/[a-z]/.test(source[flagsEnd] ?? "")) flagsEnd++;
    const flags = source.slice(end + 1, flagsEnd);
    if (op === "s" && flags.includes("e")) return { view, violation: "s///e" };
    for (let j = i; j < flagsEnd; j++) if (chars[j] !== "\n") chars[j] = " ";
    i = flagsEnd - 1;
  }
  return { view: chars.join(""), violation: null };
}

/**
 * Module roots whose members are dangerous even uncalled (`max(l, key=os.system)`),
 * so every reference to them, not just every call, must be on `allowed`.
 */
const READER_REFERENCE_ROOTS: Partial<Record<InterpolationLanguage, { roots: RegExp; allowed: ReadonlySet<string> }>> = {
  python: {
    // Importable reader modules are roots too, so an uncalled two-level
    // reference (`key=platform.os.system`) is held to the allowlist.
    roots: /^(?:os|sys|shutil|subprocess|pathlib|io|socket|ctypes|importlib|signal|tempfile|json|re|math|datetime|hashlib|base64|platform|struct|string|textwrap|collections|itertools|functools|pprint|csv|tomllib|time|statistics|decimal|fractions)$/,
    allowed: new Set(PYTHON_OS_SYS_READERS),
  },
  node: {
    roots: /^(?:fs|process|child_process)$/,
    allowed: new Set([
      "fs.readFileSync", "fs.existsSync", "fs.readdirSync", "fs.statSync", "process.version", "process.versions",
      "process.versions.*", "process.argv", "process.env", "process.env.*", "process.platform", "process.arch",
      "process.stdout.write", "process.stderr.write",
    ]),
  },
};

const CHAIN_RE = /(?<![\w$])\$?[A-Za-z_][\w$]*(?:\s*(?:\?\.|\.|->|::)\s*[A-Za-z_$][\w$]*)*/g;
const RUBY_CHAIN_RE = /(?<![\w@$:?!])[A-Za-z_]\w*[?!]?(?:\s*(?:&\.|\.|::)\s*[A-Za-z_]\w*[?!]?)*/g;
const PERL_BAREWORD_RE = /(?<![\w$@%&*:>'-])[A-Za-z_]\w*(?:::\w+)*/g;

function normalizeChain(text: string): string[] {
  return text.replace(/\s+/g, "").replace(/\?\.|->|::|&\./g, ".").split(".");
}

function namesIn(text: string): string[] {
  return text.match(/[A-Za-z_$][\w$]*/g) ?? [];
}

/**
 * Targets of `=`/`op=`/`:=` assignments: the root identifier and whether a
 * member or subscript follows it. Driven by each operator with a bounded
 * backward walk, so long spaced member chains stay linear.
 */
function assignmentTargets(view: string): { root: string; member: boolean; operatorEnd: number }[] {
  const targets: { root: string; member: boolean; operatorEnd: number }[] = [];
  for (let i = 0; i < view.length; i++) {
    if (view[i] !== "=") continue;
    const next = view[i + 1];
    if (next === "=" || next === ">" || next === "~") { i++; continue; }
    const previous = view[i - 1] ?? "";
    if ("=!<>".includes(previous) && previous !== "") continue;
    let cursor = "+-*/|&:".includes(previous) && previous !== "" ? i - 2 : i - 1;
    const limit = Math.max(0, i - 256);
    let member = false;
    let root: string | null = null;
    while (cursor >= limit) {
      cursor = skipBackSpaces(view, cursor);
      if (cursor < limit) break;
      if (view[cursor] === "]") {
        let open = cursor - 1;
        while (open >= limit && view[open] !== "[" && view[open] !== "]" && view[open] !== "\n") open--;
        if (open < limit || view[open] !== "[") break;
        member = true;
        cursor = open - 1;
        continue;
      }
      let start = cursor;
      while (start >= limit && /[\w$]/.test(view[start]!)) start--;
      if (start === cursor) break;
      const word = view.slice(start + 1, cursor + 1);
      const before = skipBackSpaces(view, start);
      if (before >= limit && view[before] === ".") {
        member = true;
        cursor = before - 1;
        continue;
      }
      if (/^[A-Za-z_$]/.test(word)) root = word;
      break;
    }
    if (root) targets.push({ root, member, operatorEnd: i + 1 });
  }
  return targets;
}

/** Names bound by assignment/declaration/parameters, used for local receivers and rebinding. */
function boundNames(
  view: string,
  source: string,
  language: InterpolationLanguage,
): { names: Set<string>; tainted: Set<string>; rebound: string | null } {
  const names = new Set<string>();
  // Python names bound by `from M import X` / `import M as X`: whatever they
  // are, only their import statement may mention them (`key=system`).
  const tainted = new Set<string>();
  const add = (list: string[]) => { for (const name of list) names.add(name); };
  let rebound: string | null = null;
  // Member/subscript assignment rebinds its root: `json.load = os.remove`.
  const fsRequire = (at: number) => /^\s*require\s*\(\s*(['"])(?:node:)?fs\1\s*\)/.test(source.slice(at));
  for (const target of assignmentTargets(view)) {
    if (target.member) { names.add(`${target.root}.`); continue; }
    if (language === "node" && target.root === "fs" && fsRequire(target.operatorEnd)) continue;
    names.add(target.root);
  }
  if (language === "python") {
    for (const match of view.matchAll(/\b(?:as|def|class)\s+([A-Za-z_]\w*)/g)) names.add(match[1]!);
    add(forLoopTargets(view));
    for (const match of view.matchAll(/\blambda\b([^:]{0,256}):/g)) add(namesIn(match[1]!));
    for (const match of view.matchAll(/\bfrom\s+[\w.]+\s+import\s+([^;\n]{0,256})/g)) {
      const imported = namesIn(match[1]!.replace(/\bas\b/g, ""));
      add(imported);
      for (const name of imported) tainted.add(name);
    }
    for (const statement of view.split(/[;\n]/)) {
      if (!/^\s*import\s/.test(statement)) continue;
      for (const alias of statement.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) tainted.add(alias[1]!);
    }
    // Statement-level tuple targets: `a, print = 1, 2`.
    for (const statement of view.split(/[;\n]/)) {
      let depth = 0;
      for (let i = 0; i < statement.length; i++) {
        const ch = statement[i]!;
        if ("([{".includes(ch)) depth++;
        else if (")]}".includes(ch)) depth--;
        else if (ch === "=" && depth === 0 && !/[=<>!]/.test(statement[i - 1] ?? "") && statement[i + 1] !== "=") {
          add(namesIn(statement.slice(0, i)).filter((name) => !/^(?:if|while|not|and|or|in|is)$/.test(name)));
          break;
        }
      }
    }
    if (/\bimport\s*\*/.test(view)) rebound = "import *";
  }
  if (language === "node") {
    for (const match of view.matchAll(/\b(?:const|let|var)\s+([^=;\n]{1,256})=/g)) {
      const declared = namesIn(match[1]!);
      if (declared.length === 1 && declared[0] === "fs" && fsRequire(match.index! + match[0].length)) continue;
      add(declared);
    }
    for (const match of view.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]!);
    for (const match of view.matchAll(/\b(?:function\s*[\w$]*|catch)\s*\(([^)]{0,256})\)/g)) add(namesIn(match[1]!));
    for (const match of view.matchAll(/\(([^()]{0,256})\)\s*=>/g)) add(namesIn(match[1]!));
    for (const match of view.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*=>/g)) names.add(match[1]!);
  }
  if (language === "ruby") {
    for (const match of view.matchAll(/\|([^|]{0,256})\|/g)) add(namesIn(match[1]!));
    add(forLoopTargets(view));
  }
  return { names, tainted, rebound };
}

function nextNonSpace(view: string, index: number): number {
  let i = index;
  while (i < view.length && /\s/.test(view[i]!)) i++;
  return i;
}

/**
 * Return the first call in an interpreter eval payload that is not on the
 * language's reader allowlist, or null when every call is a known reader.
 */
function interpreterReaderViolation(payload: string, language: InterpolationLanguage): string | null {
  const allowlist = READER_ALLOWLISTS[language];
  const syntax = { hashComments: language !== "node", slashComments: language === "node" || language === "php" };
  const details: LanguageViewDetails = { shellBodies: [] };
  let view = executableLanguageView(payload, language, details);
  if (view === null) return `${language} eval payload`;
  if (language === "ruby" || language === "perl") {
    const masked = maskRegexLiterals(payload, view, language);
    if (masked.violation) return masked.violation;
    view = masked.view;
  }
  // Backtick/qx/%x bodies run a shell whatever they contain; the view has
  // already masked them, so check them before anything reads as data.
  if (details.shellBodies.length > 0) return `${language} shell command`;
  if (language === "ruby" && /%x[^\w\s]/.test(view)) return "%x";
  // In-place edit switched on from inside the program (`$^I`, `${^I}`, ruby `$-i`).
  if (language === "perl" && /\$(?:\^I|\{\s*\^I\s*\})/.test(view)) return "$^I";
  if (language === "ruby" && /\$-i\b/.test(view)) return "$-i";
  const forbidden = allowlist.forbidden.exec(view);
  if (forbidden) return forbidden[0];
  if (language === "python") {
    const unimportable = pythonImportViolation(view);
    if (unimportable) return `import ${unimportable.slice(0, 64)}`;
  }

  if (language === "perl") return perlReaderViolation(payload, view, allowlist);

  const computed = language === "ruby" ? /\.\s*\(/.exec(view)
    : language === "php" ? /[)\]]\s*\(|\$\w*\s*\(/.exec(view)
    : /[)\]]\s*\(/.exec(view);
  if (computed) return `${language} computed call`;
  if ((language === "node" || language === "php") && /\bnew\s+(?!Date\b)[A-Za-z_\\]/.test(view)) return "new";

  const bound = boundNames(view, payload, language);
  if (bound.rebound) return bound.rebound;
  for (const name of bound.names) {
    const root = name.endsWith(".") ? name.slice(0, -1) : name;
    if (allowlist.roots.has(root)) return `${root} rebinding`;
  }
  const locals = new Set([...bound.names].filter((name) => !name.endsWith(".")));
  const references = READER_REFERENCE_ROOTS[language];

  const chainRe = language === "ruby" ? RUBY_CHAIN_RE : CHAIN_RE;
  let candidates = 0;
  for (const match of view.matchAll(chainRe)) {
    if (++candidates > LANGUAGE_CALL_CANDIDATE_BUDGET) return "language call candidate budget";
    const text = match[0]!;
    const start = match.index!;
    const end = start + text.length;
    const parts = normalizeChain(text);
    const chain = parts.join(".");
    const after = nextNonSpace(view, end);
    const before = skipBackSpaces(view, start - 1);
    const onComputedReceiver = before >= 0 && (view[before] === "." || (view[before] === ">" && view[before - 1] === "-") ||
      (view[before] === ":" && view[before - 1] === ":"));
    const precededBy = trailingWord(view, before);

    if (bound.tainted.has(parts[0]!) && !onComputedReceiver && !pythonImportStatementAt(view, start)) return chain;
    if (references && references.roots.test(parts[0]!) && !onComputedReceiver) {
      const violation = moduleReferenceViolation(view, payload, start, parts, language, references.allowed);
      if (violation) return violation;
    }

    if (language === "ruby") {
      if (view[end] === ":" && view[end + 1] !== ":") continue; // `key:` hash label
      if (onComputedReceiver) {
        const bad = parts.find((part) => !allowlist.valueMethods.has(part));
        if (bad) return `.${bad}`;
        continue;
      }
      // An identifier directly after a string literal (`"a" out`) is a Ruby
      // syntax error, and Ruby parses the whole program before running any
      // of it, so it cannot execute. Keywords (`"a" if x`) were skipped above.
      let previous = start - 1;
      // Only horizontal space: a masked comment ends at a newline.
      while (previous >= 0 && /[ \t]/.test(payload[previous]!)) previous--;
      const head = parts[0]!;
      if (previous >= 0 && view[previous] === " " && !allowlist.keywords.has(head)) continue;
      if (/^[A-Z]/.test(head)) {
        if (parts.length === 1 && view[after] !== "(") continue; // constant reference
        if (!allowlistedCall(chain, allowlist)) return chain;
        continue;
      }
      if (allowlist.keywords.has(head) || locals.has(head)) {
        const bad = parts.slice(1).find((part) => !allowlist.valueMethods.has(part));
        if (bad) return `.${bad}`;
        continue;
      }
      if (!allowlistedCall(head, allowlist)) return head;
      if (head === "require" && !/^\s*\(?\s*(['"])json\1/.test(payload.slice(end))) return "require";
      const bad = parts.slice(1).find((part) => !allowlist.valueMethods.has(part));
      if (bad) return `.${bad}`;
      continue;
    }

    if (language === "node" && onComputedReceiver) {
      // `require('fs').x` is checked by name whether or not it is called:
      // `['a'].map(require('fs').linkSync)` passes the writer uncalled.
      const receiverEnd = skipBackSpaces(view, before - 1);
      if (view[receiverEnd] === ")" && /\brequire\s*\(\s*\)$/.test(view.slice(0, receiverEnd + 1))) {
        const args = captureLanguageCall(payload, view.lastIndexOf("(", receiverEnd), syntax);
        if (nodeRequireArgument(args) === "fs") {
          if (!allowlistedCall(`fs.${chain}`, allowlist)) return `fs.${chain}`;
          continue;
        }
      }
    }
    const isCall = view[after] === "(" || (language === "node" && payload[after] === "`");
    // An uncalled `require` (`['./x.js'].map(require)`) loads arbitrary code.
    if (!isCall && language === "node" && chain === "require") return "require";
    if (!isCall) continue;
    if (precededBy && /^(?:def|function|class|fn)$/.test(precededBy)) continue; // definition, not a call
    if (onComputedReceiver) {
      const bad = parts.find((part) => !allowlist.valueMethods.has(part));
      if (bad) return `.${bad}`;
      continue;
    }
    const head = parts[0]!;
    if (parts.length === 1 && allowlist.keywords.has(language === "php" ? head.toLowerCase() : head)) continue;
    if (head.startsWith("$") || locals.has(head)) {
      if (parts.length === 1) return `${head}(`;
      const bad = parts.slice(1).find((part) => !allowlist.valueMethods.has(part));
      if (bad) return `.${bad}`;
      continue;
    }
    const name = language === "php" ? chain.toLowerCase() : chain;
    if (!allowlistedCall(name, allowlist)) return chain;
    if (language === "node" && chain === "require") {
      const args = captureLanguageCall(payload, after, syntax);
      const kind = nodeRequireArgument(args);
      if (kind === null) return "require";
      // The fs module object may only be used as `require('fs').<reader>(` or
      // bound as `const fs = require('fs')`, where `fs.*` is checked by name.
      if (kind === "fs") {
        const followedBy = view[nextNonSpace(view, after + args!.length + 2)];
        const declared = /\b(?:const|let|var)\s+fs\s*=\s*$/.test(view.slice(0, start));
        if (followedBy !== "." && !declared) return "require('fs')";
      }
    }
  }
  return null;
}

function perlReaderViolation(payload: string, view: string, allowlist: ReaderAllowlist): string | null {
  const syntax = { hashComments: true, slashComments: false };
  const ampersand = /(?<!&)&(?!&)\s*[A-Za-z_{$:]|->\s*[A-Za-z_(]/.exec(view);
  if (ampersand) return ampersand[0].trim();
  let candidates = 0;
  for (const match of view.matchAll(PERL_BAREWORD_RE)) {
    if (++candidates > LANGUAGE_CALL_CANDIDATE_BUDGET) return "language call candidate budget";
    const word = match[0]!;
    const start = match.index!;
    const end = start + word.length;
    const before = skipBackSpaces(view, start - 1);
    const after = nextNonSpace(view, end);
    if (view[before] === "{" && view[after] === "}") continue; // `$h{key}`
    if (view[after] === "=" && view[after + 1] === ">") continue; // `key => value`
    if (allowlist.keywords.has(word)) continue;
    // Upper-case barewords are filehandles (`FH`, `STDERR`) or constants
    // (`O_RDONLY`); a package-qualified name keeps its lower-case part.
    if (/^[A-Z][A-Z0-9_]*$/.test(word)) continue;
    if (!allowlist.calls.has(word)) return word;
    if (word === "open") {
      const args = view[after] === "("
        ? captureLanguageCall(payload, after, syntax)
        : captureBarePerlArguments(payload, view, after, syntax, 2);
      const fields = args === null ? null : splitTopLevelArguments(args, syntax);
      const mode = fields && fields.length >= 2 ? decodeStaticMode(fields[1]!, "perl") : null;
      if (!mode || mode.kind !== "static" || !mode.value.trim().startsWith("<") || mode.value.trim().endsWith("|")) return "open";
    }
  }
  return null;
}

/** The first module a Python import names that is not a known stdlib reader. */
function pythonImportViolation(view: string): string | null {
  for (const match of view.matchAll(/\bimport\b/g)) {
    const index = match.index!;
    // `from M import …`: M is the dotted word before `import`, after `from`.
    const moduleEnd = skipBackSpaces(view, index - 1);
    let moduleStart = moduleEnd;
    while (moduleStart >= 0 && /[\w.]/.test(view[moduleStart]!)) moduleStart--;
    const fromEnd = skipBackSpaces(view, moduleStart);
    if (trailingWord(view, fromEnd) === "from" && moduleEnd > moduleStart) {
      const module = view.slice(moduleStart + 1, moduleEnd + 1);
      if (!PYTHON_IMPORTABLE.has(module)) return module;
      continue;
    }
    const statement = view.slice(index + "import".length, index + "import".length + 256).split(/[;\n)]/)[0]!;
    for (const item of statement.split(",")) {
      const module = item.trim().replace(/\s+as\s+\w+$/, "");
      if (!PYTHON_IMPORTABLE.has(module)) return module || "*";
    }
  }
  return null;
}

/** Whether `index` falls inside a Python `import …` / `from … import …` statement. */
function pythonImportStatementAt(view: string, index: number): boolean {
  const statementStart = Math.max(view.lastIndexOf(";", index), view.lastIndexOf("\n", index)) + 1;
  return /^\s*(?:import|from)\s/.test(view.slice(statementStart, index + 1));
}

/** Check one reference rooted at a dangerous module (`os`, `fs`, `process`). */
function moduleReferenceViolation(
  view: string,
  source: string,
  start: number,
  parts: string[],
  language: InterpolationLanguage,
  allowed: ReadonlySet<string>,
): string | null {
  const chain = parts.join(".");
  if (parts.length > 1) {
    const allow: ReaderAllowlist = { ...READER_ALLOWLISTS[language], calls: allowed };
    return allowlistedCall(chain, allow) || allowlistedCall(chain, READER_ALLOWLISTS[language]) ? null : chain;
  }
  if (language === "python") {
    // A bare module name is only safe inside its import statement; any alias
    // it gets there is tainted, and `x = os` outside one fails here.
    return pythonImportStatementAt(view, start) ? null : chain;
  }
  // node: only the `const fs = require('fs')` declaration names fs bare.
  if (chain === "fs" && /\b(?:const|let|var)\s+$/.test(view.slice(0, start)) &&
    /^fs\s*=\s*require\s*\(\s*(['"])(?:node:)?fs\1\s*\)/.test(source.slice(start))) return null;
  return chain;
}

/** Subshell/process-substitution markers: content we cannot attribute to a head. */
const OPAQUE_SUBSHELL_RE = /\$\(|`|<\(|>\(/;

/**
 * Split a compound command into pipeline segments on unquoted `|`, `;`, `&&`,
 * `||`, newlines, and bare `&` (but not `>&`/`&&` fd-dup/joins). Exception-safe:
 * any confusion degrades to the whole command as one segment (= status-quo scan).
 */
export function splitCommandSegments(cmd: string): string[] {
  try {
    const shellCommand = maskHeredocBodies(cmd);
    const segments: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < shellCommand.length; i++) {
      const ch = shellCommand[i]!;
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      if (!inSingle && !inDouble && (ch === "|" || ch === ";" || ch === "&" || ch === "\n" || ch === "\r")) {
        // `2>&1` / `>&2`: an & directly after `>` is an fd dup, not a join.
        if (ch === "&" && shellCommand[i - 1] === ">") {
          current += ch;
          continue;
        }
        if (current.trim()) segments.push(current.trim());
        current = "";
        // swallow the second char of `&&` / `||`
        if (shellCommand[i + 1] === ch) i++;
        // Treat CRLF as one command separator.
        if (ch === "\r" && shellCommand[i + 1] === "\n") i++;
        continue;
      }
      current += ch;
    }
    if (current.trim()) segments.push(current.trim());
    return segments.length > 0 ? segments : [shellCommand];
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
// Exported only for the temporary parity test against command-inspection's
// DEFAULT_WRAPPERS, until the two wrapper lexers are merged.
export const WRAPPERS = new Set([
  "time", "nice", "nohup", "command", "xargs", "env", "timeout", "stdbuf", "noglob",
]);

/** Wrappers that take one positional argument (a duration) before the command. */
const WRAPPER_DURATION_RE = /^\d+(?:\.\d+)?[smhd]?$/;
const WRAPPERS_WITH_DURATION = new Set(["timeout"]);

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
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  stdbuf: new Set(["-i", "--input", "-o", "--output", "-e", "--error"]),
  noglob: new Set(),
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
  if (wrapper === "timeout") return /^-[sk].+/.test(option) || /^(?:--signal|--kill-after)=/.test(option);
  if (wrapper === "stdbuf") return /^-[ioe].+/.test(option) || /^(?:--input|--output|--error)=/.test(option);
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
  let pendingDuration = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/^\w+=/.test(token)) continue;
    if (pendingDuration && !token.startsWith("-")) {
      pendingDuration = false;
      if (WRAPPER_DURATION_RE.test(token)) continue;
      return null;
    }
    const base = token.replace(/^.*\//, "");
    if (WRAPPERS.has(base)) {
      wrapper = base;
      pendingDuration = WRAPPERS_WITH_DURATION.has(base);
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
    if (i > 0 && !/[\s;|&(){}]/.test(command[i - 1]!)) continue;
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
  known: boolean;
}

/** Parse env's short clusters without mistaking an option value for a command. */
function envOption(token: string): EnvOption {
  if (token === "--ignore-environment") return { takesArgument: false, attached: false, known: true };
  if (token === "--null" || token === "--debug") return { takesArgument: false, attached: false, known: true };
  for (const name of ["--unset", "--chdir", "--argv0"]) {
    if (token === name) return { takesArgument: true, attached: false, known: true };
    if (token.startsWith(`${name}=`)) return { takesArgument: true, attached: true, known: true };
  }
  if (token === "--split-string") return { takesArgument: true, attached: false, splitPayload: "", known: true };
  if (token.startsWith("--split-string=")) return {
    takesArgument: true,
    attached: true,
    splitPayload: token.slice("--split-string=".length),
    known: true,
  };
  if (token === "-i" || token === "-0" || token === "-v") return { takesArgument: false, attached: false, known: true };
  if (!token.startsWith("-") || token.startsWith("--")) return { takesArgument: false, attached: false, known: false };
  const flags = token.slice(1);
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (flag === "i" || flag === "0" || flag === "v") continue;
    if (flag !== "u" && flag !== "C" && flag !== "S" && flag !== "P") return { takesArgument: false, attached: false, known: false };
    const rest = flags.slice(i + 1);
    return {
      takesArgument: true,
      attached: rest.length > 0,
      ...(flag === "S" ? { splitPayload: rest } : {}),
      known: true,
    };
  }
  return { takesArgument: false, attached: false, known: true };
}

const ENV_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

interface EnvInvocationNormalization {
  argv: string[];
  assignments: string[];
  envSeen: boolean;
  complete: boolean;
}

const ENV_MAX_DEPTH = 8;
const ENV_MAX_ARGV = 256;
const ENV_MAX_CHARS = 64 * 1024;

function incompleteEnvNormalization(): EnvInvocationNormalization {
  return { argv: [], assignments: [], envSeen: true, complete: false };
}

/** Normalize only an effective executable prefix, including nested env. */
function normalizeEnvInvocation(tokens: string[], depth = 0, inherited: string[] = []): EnvInvocationNormalization {
  if (depth > ENV_MAX_DEPTH || tokens.length > ENV_MAX_ARGV || tokens.join(" ").length > ENV_MAX_CHARS) {
    return incompleteEnvNormalization();
  }
  const assignments = [...inherited];
  let index = 0;
  let envSeen = false;
  const consumeAssignments = () => {
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (ENV_ASSIGNMENT_RE.test(token)) { assignments.push(token); index++; continue; }
      // shellWords keeps a trailing command separator attached to an
      // assignment (`x=1; [[ ... ]]`). It is still an assignment prefix for
      // head resolution; retaining the token keeps Git-name matching strict.
      if (/^[A-Za-z_][A-Za-z0-9_]*=[^;|&(){}[\]]+[;|&(){}[\]]/.test(token)) {
        assignments.push(token);
        index++;
      }
      break;
    }
  };
  const consumeWrapperOptions = (wrapper: string): boolean => {
    while (index < tokens.length && tokens[index]!.startsWith("-")) {
      const option = tokens[index]!;
      if (option === "--") { index++; return true; }
      const optionSet = WRAPPER_OPTIONS_WITH_VALUE[wrapper];
      if (optionSet?.has(option) && !wrapperOptionHasAttachedValue(wrapper, option)) {
        if (++index >= tokens.length) return false;
      }
      index++;
    }
    return true;
  };

  consumeAssignments();

  while (index < tokens.length) {
    const base = tokens[index]!.replace(/^.*\//, "");
    if (base !== "env") {
      if (tokens[index]!.includes("=") && !/[;|&(){}[\]]/.test(tokens[index]!)) return incompleteEnvNormalization();
      if (!WRAPPERS.has(base)) return { argv: tokens.slice(index), assignments, envSeen, complete: true };
      index++;
      if (!consumeWrapperOptions(base)) return incompleteEnvNormalization();
      if (WRAPPERS_WITH_DURATION.has(base)) {
        // `timeout DURATION CMD`: a missing or malformed duration leaves the
        // command position unknown, so fail closed rather than guess.
        if (index >= tokens.length) return { argv: [], assignments, envSeen, complete: true };
        if (!WRAPPER_DURATION_RE.test(tokens[index]!)) return incompleteEnvNormalization();
        index++;
      }
      consumeAssignments();
      continue;
    }

    envSeen = true;
    index++;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (ENV_ASSIGNMENT_RE.test(token)) { assignments.push(token); index++; continue; }
      if (token === "--") { index++; break; }
      if (!token.startsWith("-")) break;
      const option = envOption(token);
      if (!option.known) return incompleteEnvNormalization();
      if (option.splitPayload !== undefined) {
        let payload = option.splitPayload;
        if (!option.attached) {
          if (++index >= tokens.length) return incompleteEnvNormalization();
          payload = tokens[index]!;
        }
        if (payload.length > ENV_MAX_CHARS) return incompleteEnvNormalization();
        const parsed = shellArguments(payload);
        if (!parsed.complete || parsed.args.some((argument) => argument.dynamic)) return incompleteEnvNormalization();
        const composed = parsed.args.map((argument) => argument.value).concat(tokens.slice(index + 1));
        if (composed.length > ENV_MAX_ARGV || composed.join(" ").length > ENV_MAX_CHARS) return incompleteEnvNormalization();
        const nested = normalizeEnvInvocation(composed, depth + 1, assignments);
        return { ...nested, envSeen: true };
      }
      if (option.takesArgument && !option.attached) {
        if (++index >= tokens.length) return incompleteEnvNormalization();
      }
      index++;
    }
    consumeAssignments();
    if (index >= tokens.length) return { argv: [], assignments, envSeen, complete: true };
  }
  return { argv: [], assignments, envSeen, complete: true };
}

export function effectiveHead(segment: string): string | null {
  const normalized = normalizeEnvInvocation(shellWords(segment));
  if (!normalized.complete || normalized.argv.length === 0) return null;
  const base = normalized.argv[0]!.replace(/^.*\//, "");
  return base || null;
}

/**
 * Inspect only the prefix that launches Git. Assignment-looking text in Git
 * arguments (especially after `--`) is data and must not trigger this check.
 * Assignments are supplied by the bounded env normalizer, including nested
 * `env`/`command` forms.
 */
function gitEnvironmentPrefixMutation(assignments: string[]): string | null {
  for (const token of assignments) {
    const assignment = ENV_ASSIGNMENT_RE.exec(token);
    if (!assignment) continue;
    const name = assignment[1]!;
    if (GIT_COMMAND_ENV_NAME_RE.test(name)) return name;
    if (name.startsWith("GIT_CONFIG_KEY_") || name.startsWith("GIT_CONFIG_VALUE_")) return name;
  }
  return null;
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
  let substitutionDepth = 0;
  let backtickDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
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
    } else if (ch === "$" && command[i + 1] === "(") {
      current += "$(";
      substitutionDepth++;
      i++;
    } else if (ch === "`") {
      current += ch;
      backtickDepth = backtickDepth === 0 ? 1 : 0;
    } else if (substitutionDepth > 0 || backtickDepth > 0) {
      if (substitutionDepth > 0) {
        if (ch === "(") substitutionDepth++;
        else if (ch === ")") substitutionDepth--;
      }
      current += ch;
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

interface ShellArgument {
  value: string;
  /** True when the outer shell must expand this argument before `-c` runs. */
  dynamic: boolean;
}

interface ShellArguments {
  args: ShellArgument[];
  complete: boolean;
}

/**
 * Parse shell argv while retaining whether each word contains an outer-shell
 * expansion. `shellWords` intentionally discards that distinction for normal
 * command classification; `sh -c` needs it because its next argv item is code.
 */
function shellArguments(command: string): ShellArguments {
  const args: ShellArgument[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let dynamic = false;
  let started = false;

  const push = () => {
    if (!started) return;
    args.push({ value: current, dynamic });
    current = "";
    dynamic = false;
    started = false;
  };

  for (const ch of command) {
    if (escaped) {
      if (quote === '"' && !/[\\$`"\n]/.test(ch)) current += "\\";
      current += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else {
        current += ch;
        if (quote === '"' && (ch === "$" || ch === "`")) dynamic = true;
      }
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      push();
    } else {
      current += ch;
      if (ch === "$" || ch === "`") dynamic = true;
      started = true;
    }
  }
  if (escaped || quote !== null) return { args, complete: false };
  push();
  return { args, complete: true };
}

interface ShellEvalPayload {
  payload: string | null;
  ambiguous: boolean;
}

/** Extract a static `-c` payload from an actual shell invocation, through wrappers. */
function shellEvalPayload(segment: string): ShellEvalPayload | null {
  const parsed = shellArguments(segment);
  if (!parsed.complete) return null;
  const tokens = parsed.args.map((arg) => arg.value);
  const normalized = normalizeEnvInvocation(tokens);
  if (!normalized.complete) return { payload: null, ambiguous: true };
  if (normalized.argv.length === 0) return null;
  const index = 0;
  const head = normalized.argv[index]!.replace(/^.*\//, "");
  if (!EVAL_SHELLS.has(head)) return null;

  const rawHeadIndex = tokens.findIndex((token) => token.replace(/^.*\//, "") === head);
  if (rawHeadIndex >= 0) {
    for (let i = rawHeadIndex + 1; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token === "--") break;
      if (token !== "-c" && !/^-[-\w]*c[^-]*$/.test(token)) continue;
      const argument = parsed.args[i + 1];
      if (!argument || argument.dynamic) return { payload: null, ambiguous: true };
      if (argument.value.length > MAX_LANGUAGE_ARGUMENT_LENGTH) return { payload: null, ambiguous: true };
      return { payload: argument.value, ambiguous: false };
    }
    return null;
  }

  for (let i = index + 1; i < normalized.argv.length; i++) {
    const token = normalized.argv[i]!;
    if (token === "--") break;
    if (token !== "-c" && !/^-[^-]*c[^-]*$/.test(token)) continue;
    const argument = normalized.argv[i + 1];
    if (!argument || /[$`]/.test(argument)) return { payload: null, ambiguous: true };
    if (argument.length > MAX_LANGUAGE_ARGUMENT_LENGTH) return { payload: null, ambiguous: true };
    return { payload: argument, ambiguous: false };
  }
  return null;
}

/** Return a command-bearing assignment inherited by a shell `-c` payload. */
function shellEnvironmentPrefixMutation(segment: string): string | null {
  const normalized = normalizeEnvInvocation(shellWords(segment));
  return normalized.complete ? gitEnvironmentPrefixMutation(normalized.assignments) : null;
}

function gitReadOnlySubformOption(
  token: string,
  allowed: Set<string>,
  valueOptions: Set<string>,
): { known: boolean; consumesNext: boolean } {
  if (!token.startsWith("-")) return { known: true, consumesNext: false };
  const equals = token.indexOf("=");
  const name = equals < 0 ? token : token.slice(0, equals);
  if (!allowed.has(name)) return { known: false, consumesNext: false };
  return { known: true, consumesNext: equals < 0 && valueOptions.has(name) };
}

/**
 * Read-only Git subforms are argv grammars, not prefixes. A later action or
 * option must invalidate the allowlist; after `--`, every token is data.
 * Unknown options fail closed because this intentionally covers only the
 * narrow display/query forms used by the classifier.
 */
function isGitReadOnlySubform(tokens: string[], verbIndex: number): boolean {
  const verb = tokens[verbIndex];
  const subform = tokens[verbIndex + 1];
  let allowed: Set<string>;
  let values: Set<string>;
  let bareActions: Set<string>;
  if (verb === "branch" && (subform === "-l" || subform === "--list" || subform === "-v" || subform === "-vv")) {
    allowed = new Set(["-l", "--list", "-v", "-vv", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--column", "--no-column", "--color", "--no-color"]);
    values = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--color"]);
    bareActions = new Set();
  } else if (verb === "tag" && (subform === "-l" || subform === "--list")) {
    allowed = new Set(["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--column", "--no-column", "--color", "--no-color"]);
    values = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format", "--color"]);
    bareActions = new Set();
  } else if (verb === "stash" && (subform === "list" || subform === "show")) {
    allowed = new Set(["list", "show", "-p", "--patch", "--stat", "--summary", "--name-only", "--name-status", "--oneline", "--format", "--pretty", "--include-untracked", "--no-include-untracked"]);
    values = new Set(["--format", "--pretty"]);
    bareActions = new Set(["drop", "pop", "apply", "clear", "branch", "push", "create", "store"]);
  } else if (verb === "config" && (subform === "--get" || subform?.startsWith("--get-") || subform === "--list" || subform === "-l")) {
    allowed = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--show-origin", "--show-scope", "--show-names", "--name-only", "--includes", "--null", "--fixed-value", "--type", "--default", "--local", "--global", "--system", "--file", "--blob"]);
    values = new Set(["--type", "--default", "--file", "--blob"]);
    bareActions = new Set();
  } else if (verb === "remote" && (subform === "-v" || subform === "show")) {
    allowed = new Set(["-v", "show", "-n", "--no-query", "--get-url"]);
    values = new Set();
    bareActions = new Set(["add", "remove", "rename", "set-head", "set-branches", "set-url", "prune", "update"]);
  } else {
    return false;
  }

  for (let i = verbIndex + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") return true;
    if (!token.startsWith("-")) {
      if (bareActions.has(token)) return false;
      continue;
    }
    const parsed = gitReadOnlySubformOption(token, allowed, values);
    if (!parsed.known) {
      return false;
    }
    if (parsed.consumesNext) {
      if (i + 1 >= tokens.length || tokens[i + 1] === "--" || tokens[i + 1]!.startsWith("-")) return false;
      i++;
    }
  }
  return true;
}

function gitConfigOptionMutation(tokens: string[], index: number): { token: string | null; consumed: number } {
  const option = tokens[index]!;
  const separate = option === "-c" || option === "--config-env";
  const raw = separate ? tokens[index + 1] : option.startsWith("-c") ? option.slice(2) : option.startsWith("--config-env=") ? option.slice("--config-env=".length) : null;
  if (!raw || !raw.includes("=")) return { token: option, consumed: separate ? 1 : 0 };
  const key = raw.split("=", 1)[0]!.trim();
  // A dynamic or malformed key could resolve to a command-bearing setting;
  // only the ordinary static Git key alphabet is safe to inspect further.
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(key) || GIT_COMMAND_CONFIG_KEY_RE.test(key)) {
    return { token: option, consumed: separate ? 1 : 0 };
  }
  return { token: null, consumed: separate ? 1 : 0 };
}

function gitReadOnlyOptionMutation(tokens: string[], start: number): string | null {
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "--") return null;
    if (token === "--ext-diff" || token === "--textconv" || token === "--paginate" || token === "-p" ||
      /^--open-files-in-pager(?:=|$)/.test(token) || /^--output(?:=|$)/.test(token) || /^-[^-]*o(?:.|$)/.test(token)) {
      return token;
    }
    if (token === "--no-ext-diff" || token === "--no-textconv") continue;
  }
  return null;
}

/**
 * Return a mutation token for a Git segment whose verb is not allowlisted, or
 * null for an established read-only verb/subform. Global options are skipped
 * only in this verb position; their values are never treated as commands.
 */
function findGitMutationToken(segment: string): string | null {
  const tokens = shellWords(segment);
  const normalized = normalizeEnvInvocation(tokens);
  if (!normalized.complete) return "ambiguous env invocation";
  if (normalized.argv.length === 0) return null;
  const gitIndex = 0;
  if (normalized.argv[gitIndex]!.replace(/^.*\//, "") !== "git") return null;
  const environmentMutation = gitEnvironmentPrefixMutation(normalized.assignments);
  if (environmentMutation) return environmentMutation;

  let verbIndex = gitIndex + 1;
  let readOnlyGlobalQuery = false;
  while (verbIndex < normalized.argv.length) {
    const option = normalized.argv[verbIndex]!;
    if (option === "--") {
      verbIndex++;
      break;
    }
    if (option === "-p" || option === "--paginate") return `git ${option}`;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(option)) {
      if (option === "-c" || option === "--config-env") {
        const config = gitConfigOptionMutation(normalized.argv, verbIndex);
        if (config.token) return `git ${config.token}`;
        verbIndex += 2;
      } else {
        verbIndex += 2;
      }
      continue;
    }
    if (option.startsWith("--config-env=") || (option.startsWith("-c") && option.length > 2)) {
      const config = gitConfigOptionMutation(normalized.argv, verbIndex);
      if (config.token) return `git ${config.token}`;
      verbIndex++;
      continue;
    }
    if (
      option.startsWith("--git-dir=") ||
      option.startsWith("--work-tree=") ||
      option.startsWith("--namespace=") ||
      option.startsWith("--super-prefix=") ||
      (option.startsWith("-C") && option.length > 2)
    ) {
      verbIndex++;
      continue;
    }
    if (option.startsWith("--exec-path=")) {
      readOnlyGlobalQuery = true;
      verbIndex++;
      continue;
    }
    if (option === "--exec-path") {
      readOnlyGlobalQuery = true;
      const value = normalized.argv[verbIndex + 1];
      // Git's exec-path argument is optional. Consume only an unmistakable
      // path so a mutating-looking token such as `add` cannot disappear as a
      // purported option value.
      if (value && /^(?:~|\.{0,2}\/|\/)/.test(value)) verbIndex += 2;
      else verbIndex++;
      continue;
    }
    if (GIT_GLOBAL_OPTIONS.has(option)) {
      if (GIT_READ_ONLY_GLOBAL_OPTIONS.has(option)) readOnlyGlobalQuery = true;
      verbIndex++;
      continue;
    }
    break;
  }

  const verb = normalized.argv[verbIndex];
  if (!verb) return readOnlyGlobalQuery ? null : "git";
  if (READ_ONLY_GIT_VERBS.has(verb)) {
    const optionMutation = gitReadOnlyOptionMutation(normalized.argv, verbIndex + 1);
    return optionMutation ? `git ${optionMutation}` : null;
  }
  if (isGitReadOnlySubform(normalized.argv, verbIndex)) return null;
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
  // Shell quotes may surround the complete `-ePROGRAM` token, so use the
  // argv-aware preflight before falling back to the legacy raw spelling.
  if (EVAL_INTERPRETERS.has(head)) {
    const evaluation = directInterpreterEvalPreflight(segment);
    if (evaluation?.interpreter === head) return true;
    if (head === "php") return /\s(?:-\w*r\w*|--run)\b/.test(segment);
    return /\s(-\w*[ecnp]\w*|--eval|--print)\b/.test(segment);
  }
  if (EVAL_SHELLS.has(head)) return /\s-c\b/.test(segment);
  return false;
}

function findInterpreterWriter(head: string, segment: string): string | null {
  if (segment.length > MAX_LANGUAGE_ARGUMENT_LENGTH) return `${head} eval payload`;
  const payload = interpreterEvalPayload(segment);
  const language = interpreterLanguage(head);
  return scanLanguagePayload(payload, language, {
    depth: 0,
    shellBodies: new Set(),
    shellBodyCount: 0,
  });
}

/** Run the segment's READ_ONLY_HEAD_WRITES predicate, if its effective head has one. */
function readOnlyHeadWrite(segment: string, depth: number, followingText: string | null): string | null {
  const normalized = normalizeEnvInvocation(shellWords(segment));
  if (!normalized.complete || normalized.argv.length === 0) return null;
  const head = normalized.argv[0]!.replace(/^.*\//, "");
  const check = Object.hasOwn(READ_ONLY_HEAD_WRITES, head) ? READ_ONLY_HEAD_WRITES[head]! : undefined;
  if (!check) return null;
  return check(normalized.argv.slice(1), {
    inspect: (argv) => findDestructiveTokenInternal(argv.map(shellQuoteWord).join(" "), depth + 1),
    followingText,
    assignments: normalized.assignments,
  });
}

/**
 * The classifier. Returns the offending token for the hard-stop message, or
 * null when the command is (heuristically) read-only.
 */
function findDestructiveTokenInternal(cmd: string, depth: number): string | null {
  if (depth >= 32) return "complex shell syntax";
  const normalized = normalizeEnvInvocation(shellWords(cmd));
  if (!normalized.complete) return "ambiguous env invocation";
  // Avoid sending oversized interpreter payloads through the recursive shell
  // inspection machinery. They cannot be parsed within the language-call
  // budget, so fail closed before any potentially quadratic traversal.
  const evalPreflight = interpreterEvalPreflight(cmd);
  if (evalPreflight && evalPreflight.payloadLength > LANGUAGE_EVAL_EARLY_LIMIT) {
    return "oversized interpreter eval";
  }
  // Here-document bodies are shell data, not separate command clauses. Keep
  // them out of every structural recursion below so a literal `>` in the body
  // cannot be mistaken for a redirect.
  const shellCommand = maskHeredocBodies(cmd);
  // Use the shared bounded traversal as a structural preflight so executable
  // control clauses and substitution bodies cannot disappear between the
  // core classifier and host policy adapters. Incomplete or over-budget shell
  // syntax is never allowed to fall through to the safe tier.
  if (!inspectCommandSubstitutionTree(shellCommand).complete) return "complex shell syntax";
  const sanitized = sanitizeForRedirect(shellCommand);

  const redirect = REDIRECT_RE.exec(sanitized);
  if (redirect) return redirect[0].trim() || ">";

  const segments = splitCommandSegments(shellCommand);

  // Quoted command substitutions still execute their `$()`/backtick bodies.
  // Recurse with a finite budget so nested syntax cannot hide a mutation while
  // malformed or adversarially deep input remains bounded.
  const substitutionInspection = inspectCommandSubstitutions(shellCommand);
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
  const trimmed = shellCommand.trim();
  if (/^case\b/.test(trimmed) && !inspectShellCommandClauses(trimmed).complete) return "complex shell syntax";
  if (/^coproc(?:\s|$)/.test(trimmed) && extractShellCommandClauses(trimmed).length === 0) {
    return "complex shell syntax";
  }

  // Parenthesized groups execute their contents even though the outer shell
  // segment starts with `(`. Inspect each group recursively, while the
  // quote-aware extractor leaves literal parentheses untouched.
  for (const group of parenthesizedGroups(shellCommand)) {
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

  for (const clause of extractShellCommandClauses(shellCommand)) {
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
    // These shell builtins execute caller-provided command text or source a
    // file. Their static arguments are not evidence of read-only behavior;
    // this check also runs on recursively extracted -c/control/function
    // clauses, while quoted words remain data because they are not heads.
    if (head && SHELL_COMMAND_CONTROL_HEADS.has(head)) return head;
  }

  // Read-only heads skip the word scan, so each one's own write/exec forms
  // (`sed -n 'w F'`, `sort --output=F`, awk `print | "sh"`, `find -okdir rm`)
  // are decided here from its argv, before the safe tier can wave it through.
  // Segments are trimmed, in-order slices of shellCommand, so the text after
  // each one can be located by a forward search.
  let segmentCursor = 0;
  for (const segment of segments) {
    const at = shellCommand.indexOf(segment, segmentCursor);
    const followingText = at === -1 ? null : shellCommand.slice(at + segment.length);
    if (at !== -1) segmentCursor = at + segment.length;
    const token = readOnlyHeadWrite(stripShellControlPrefix(segment), depth, followingText);
    if (token) return token;
  }

  // Git is allowlist-oriented at the verb position. Inspect it before the
  // generic scan so read-only Git search patterns remain data, not commands.
  const gitTokens = segments.map(findGitMutationToken);
  for (const token of gitTokens) {
    if (token) return token;
  }

  // A shell's `-c` argument is executable code, not inert command data. Only
  // recurse when the effective head is an actual supported shell; quoted
  // strings passed to readers such as `echo` and `grep` never reach this path.
  const readOnlyShellSegments = new Set<number>();
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    const shell = shellEvalPayload(segment);
    if (!shell) continue;
    if (shell.ambiguous) return "shell eval payload";
    if (shell.payload !== null) {
      const inheritedEnvironmentMutation = shellEnvironmentPrefixMutation(segment);
      if (inheritedEnvironmentMutation) {
        const clauses = extractShellCommandClauses(shell.payload);
        for (const clause of clauses.length > 0 ? clauses : [shell.payload]) {
          const inherited = findGitMutationToken(`${inheritedEnvironmentMutation}=1 ${clause}`);
          if (inherited) return inheritedEnvironmentMutation;
        }
      }
      const nested = findDestructiveTokenInternal(shell.payload, depth + 1);
      if (nested) return `shell ${nested}`;
      readOnlyShellSegments.add(i);
    }
  }

  // Safe tier: every head is a pure reader (its write/exec forms were already
  // stopped above), and there is no subshell content we can't attribute.
  // Word-scan skipped.
  const allSafe =
    !OPAQUE_SUBSHELL_RE.test(shellCommand) &&
    heads.every((head, i) => {
      if (readOnlyShellSegments.has(i)) return true;
      const gitReadOnly = head === "git" && gitTokens[i] === null;
      return head !== null && (READ_ONLY_HEADS.has(head) || gitReadOnly);
    });
  if (allSafe) return null;

  const caseInspection = inspectShellCommandClauses(shellCommand);
  const wordScanSegments = /^case\b/.test(shellCommand.trim()) && caseInspection.complete && caseInspection.clauses.length > 0
    ? caseInspection.clauses
    : segments;
  const wordScanText = wordScanSegments.map((segment, i) => {
    // Control-clause prefixes are syntax, not argv data. Strip them before
    // language masking so `if command perl -eprint("unlink('x')")` resolves
    // the wrapped interpreter instead of scanning its quoted program text as
    // ordinary shell words.
    const scanSegment = stripShellControlPrefix(segment);
    return languageWordScanSegment(effectiveHead(scanSegment) ?? heads[i] ?? "", scanSegment);
  }).join(" | ");
  const word = WORD_RE.exec(sanitizeForRedirect(wordScanText));
  if (word) return word[0].trim();

  // Interpreter eval payloads: scan the RAW segment — writer APIs live inside
  // the quotes the sanitizer deliberately preserves words in.
  for (let i = 0; i < segments.length; i++) {
    const head = heads[i];
    if (!head) continue;
    const segment = stripShellControlPrefix(segments[i]!);
    if (EVAL_INTERPRETERS.has(head) && INPLACE_EDIT_RE.test(segment)) return "-i";
    if (isEvalInvocation(head, segment)) {
      const languageWriter = findInterpreterWriter(head, segment);
      if (languageWriter) return languageWriter;
      const writerPayload = interpreterEvalPayload(segment);
      const language = interpreterLanguage(head);
      const writerSource = executableLanguageView(writerPayload, language);
      if (writerSource === null) return `${head} eval payload`;
      const writer = EVAL_WRITER_RE.exec(writerSource);
      if (writer) return writer[0].trim();
    }
    // The allowlist runs on programs extracted with the interpreter's own
    // option grammar, independent of isEvalInvocation's spellings (`perl -E`,
    // `python3 -Ic`, `node --eval=`), and re-runs the writer screens on them.
    if (EVAL_INTERPRETERS.has(head)) {
      const extracted = interpreterEvalPrograms(segment);
      if (extracted.kind === "violation") return `${head} eval: ${extracted.reason}`;
      if (extracted.kind === "eval") {
        const language = interpreterLanguage(head);
        const programs = extracted.join ? [extracted.programs.join("\n")] : extracted.programs;
        for (const program of programs) {
          if (program.length > MAX_LANGUAGE_ARGUMENT_LENGTH) return `${head} eval payload`;
          const writer = scanLanguagePayload(program, language, { depth: 0, shellBodies: new Set(), shellBodyCount: 0 });
          if (writer) return writer;
          const view = executableLanguageView(program, language);
          if (view === null) return `${head} eval payload`;
          const fsWriter = EVAL_WRITER_RE.exec(view);
          if (fsWriter) return fsWriter[0].trim();
          const unlisted = interpreterReaderViolation(program, language);
          if (unlisted) return `${head} eval: ${unlisted}`;
        }
      }
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
