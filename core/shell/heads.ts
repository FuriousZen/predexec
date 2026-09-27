/**
 * Read-only command heads for the destructive-command heuristic
 * (core/destructive.ts): the READ_ONLY_HEADS allowlist that lets a segment skip
 * the word scan, and the per-head argv predicates (READ_ONLY_HEAD_WRITES) that
 * catch each reader's own write/exec forms — `sed -n 'w F'`, `sort -o F`,
 * awk `print > F`, `find -exec`, LESSOPEN, and so on.
 */

import {
  ENV_ASSIGNMENT_RE,
  isAppendAssignment,
} from "./lexer.ts";

/**
 * Command heads that only ever read (absent a write/exec form caught by
 * READ_ONLY_HEAD_WRITES below). Membership buys two things: skipping the
 * word-scan, so quoted writer words in their arguments (grep/rg patterns, jq
 * programs) stop false-positive hard-stopping; and passing the allowlist
 * inversion (an unknown head is mutating). The redirect check still applies
 * to them. Curated from a measured exploration set (Task 9): add a head only
 * when it can neither write nor run another program, or when a
 * READ_ONLY_HEAD_WRITES predicate stops every form that does.
 */
export const READ_ONLY_HEADS = new Set([
  "cat", "ls", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "file",
  "stat", "du", "df", "ps", "printenv", "echo", "printf", "which",
  "whereis", "type", "pwd", "whoami", "id", "uname", "date", "hostname",
  "sort", "uniq", "cut", "tr", "column", "comm", "join", "paste", "fold",
  "rev", "nl", "od", "xxd", "hexdump", "strings", "basename", "dirname",
  "realpath", "readlink", "md5sum", "sha1sum", "sha256sum", "diff", "cmp",
  "less", "more", "tree", "jq", "yq", "awk", "gawk", "mawk", "sed", "find",
  "tac", "sha224sum", "sha384sum", "sha512sum", "b2sum", "cksum", "sum", "shasum", "md5",
  "seq", "expr", "yes", "uptime", "nproc", "sw_vers", "locale", "groups", "pgrep", "lsof",
  "tty", "logname", "users", "who", "getconf", "fd", "fdfind", "base64", "mapfile", "readarray",
  "look", "pr", "iconv",
]);

/**
 * Shell builtins (and `sleep`) that neither write nor run command text: they
 * pass the allowlist inversion but, unlike READ_ONLY_HEADS, keep the word
 * scan. Declarations of command-bearing variables (`export LESSOPEN=…`) are
 * stopped earlier (env.ts), and `let`'s arithmetic over data-derived values
 * by taint.ts. Deliberately absent: `eval`/`source`/`.`/`exec` (run text),
 * `alias` (defines commands), `trap` (runs text on a signal), `shopt`,
 * `ulimit`, `umask`.
 */
export const SHELL_BUILTIN_READERS: ReadonlySet<string> = new Set([
  ":", "true", "false", "test", "[", "[[", "cd", "pushd", "popd", "dirs", "read", "export", "declare",
  "typeset", "local", "readonly", "unset", "set", "shift", "exit", "return", "break", "continue", "wait",
  "getopts", "sleep", "let",
]);

/**
 * The options one read verb may carry: `flags` stand alone, `values` take the
 * next word or an attached `--name=value`. Anything else — another option,
 * a short cluster, an attached short value — is not a known read (R43).
 */
interface ReadOptions {
  flags?: readonly string[];
  values?: readonly string[];
}

/**
 * A multi-tool whose read verbs, and every option each accepts, are listed.
 * `global` options may appear before the verb and after it; a verb maps to its
 * options, or to `{ sub }` when a second word picks the read (`config view`).
 */
interface SubcommandReaders {
  global: ReadOptions;
  verbs: Readonly<Record<string, ReadOptions | { sub: Readonly<Record<string, ReadOptions>> }>>;
  /** An operand the verb must not take (a path brew would load as Ruby). */
  badOperand?: (arg: string) => boolean;
}

const HELP_OR_VERSION = new Set(["--help", "-h", "--version", "-v", "-V"]);

/** Consume the option at `args[i]`; the index of its last word, or -1 when it is not allowed. */
function allowedOption(args: readonly string[], i: number, ...sets: ReadOptions[]): number {
  const word = args[i]!;
  const eq = word.startsWith("--") ? word.indexOf("=") : -1;
  const name = eq === -1 ? word : word.slice(0, eq);
  // A listed flag may itself hold `=` (`--paging=never`).
  if (sets.some((set) => set.flags?.includes(word))) return i;
  if (!sets.some((set) => set.values?.includes(name))) return -1;
  if (eq !== -1) return i;
  return i + 1 < args.length ? i + 1 : -1;
}

function subcommandReads(spec: SubcommandReaders, args: readonly string[]): boolean {
  if (args.length > 0 && args.every((arg) => HELP_OR_VERSION.has(arg))) return true;
  let i = 0;
  for (; i < args.length; i++) {
    const word = args[i]!;
    if (Object.hasOwn(spec.verbs, word) || !word.startsWith("-")) break;
    const end = allowedOption(args, i, spec.global);
    if (end === -1) return false;
    i = end;
  }
  // A bare invocation (or globals only) prints usage.
  if (i >= args.length) return true;
  const verb = args[i]!;
  if (!Object.hasOwn(spec.verbs, verb)) return false;
  let options = spec.verbs[verb]!;
  i++;
  if ("sub" in options) {
    const second = args[i];
    if (second === undefined || !Object.hasOwn(options.sub, second)) return false;
    options = options.sub[second]!;
    i++;
  }
  for (; i < args.length; i++) {
    const word = args[i]!;
    if (word === "--") return !args.slice(i + 1).some((arg) => spec.badOperand?.(arg));
    if (word.startsWith("-") && word !== "-") {
      const end = allowedOption(args, i, options as ReadOptions, spec.global);
      if (end === -1) return false;
      i = end;
      continue;
    }
    if (spec.badOperand?.(word)) return false;
  }
  return true;
}

const K8S_SELECT = ["-n", "--namespace", "-l", "--selector", "--field-selector"];
const K8S_OUTPUT = ["-o", "--output", "--template", "--sort-by"];
const KUBECTL: SubcommandReaders = {
  // Not -s/--server, --kubeconfig, --token, --cache-dir, --log-file: they send
  // the context's credentials elsewhere, run a kubeconfig's exec plugin, or write.
  global: { values: ["-n", "--namespace", "--context", "--cluster", "--user", "--request-timeout"] },
  verbs: {
    get: {
      flags: ["-A", "--all-namespaces", "-w", "--watch", "--watch-only", "--show-labels", "--no-headers", "--show-kind",
        "--ignore-not-found"],
      values: [...K8S_SELECT, ...K8S_OUTPUT, "-L", "--label-columns", "--chunk-size", "--raw", "-f", "--filename"],
    },
    describe: { flags: ["-A", "--all-namespaces", "--show-events"], values: [...K8S_SELECT, "-f", "--filename"] },
    logs: {
      flags: ["-f", "--follow", "-p", "--previous", "--timestamps", "--all-containers", "--prefix"],
      values: [...K8S_SELECT, "-c", "--container", "--tail", "--since", "--since-time", "--limit-bytes"],
    },
    explain: { flags: ["--recursive"], values: ["--api-version", "-o", "--output"] },
    "api-resources": { flags: ["--namespaced", "--no-headers"], values: ["-o", "--output", "--api-group", "--verbs", "--sort-by"] },
    "api-versions": {},
    version: { flags: ["--client"], values: ["-o", "--output"] },
    top: { sub: Object.fromEntries(["pod", "pods", "po", "node", "nodes", "no"].map((kind) =>
      [kind, { flags: ["-A", "--all-namespaces", "--containers", "--no-headers"], values: [...K8S_SELECT, "--sort-by"] }])) },
    events: { flags: ["-A", "--all-namespaces", "-w", "--watch"], values: [...K8S_SELECT, ...K8S_OUTPUT, "--for", "--types"] },
    config: {
      sub: {
        view: { flags: ["--minify", "--raw", "--flatten"], values: ["-o", "--output"] },
        "get-contexts": { flags: ["--no-headers"], values: ["-o", "--output"] },
        "current-context": {},
        "get-clusters": {},
        "get-users": {},
      },
    },
    auth: { sub: { "can-i": { flags: ["--list", "-A", "--all-namespaces", "-q", "--quiet"] }, whoami: { values: ["-o", "--output"] } } },
  },
};

const DOCKER_PS: ReadOptions = {
  flags: ["-a", "--all", "-q", "--quiet", "--no-trunc", "-l", "--latest", "-s", "--size"],
  values: ["-f", "--filter", "--format", "-n", "--last"],
};
const DOCKER_IMAGES: ReadOptions = { flags: ["-a", "--all", "-q", "--quiet", "--no-trunc", "--digests"], values: ["-f", "--filter", "--format"] };
const DOCKER_INSPECT: ReadOptions = { flags: ["-s", "--size"], values: ["-f", "--format", "--type"] };
const DOCKER_LOGS: ReadOptions = { flags: ["-f", "--follow", "-t", "--timestamps", "--details"], values: ["--tail", "-n", "--since", "--until"] };
const DOCKER_HISTORY: ReadOptions = { flags: ["-H", "--human", "-q", "--quiet", "--no-trunc"], values: ["--format"] };
const DOCKER_STATS: ReadOptions = { flags: ["-a", "--all", "--no-stream", "--no-trunc"], values: ["--format"] };
const DOCKER_LIST: ReadOptions = { flags: ["-q", "--quiet", "--no-trunc"], values: ["-f", "--filter", "--format"] };
const DOCKER_FORMAT: ReadOptions = { values: ["-f", "--format"] };
const DOCKER: SubcommandReaders = {
  // Not --config/-H/--host: a config directory or remote host chooses helpers to run.
  global: { flags: ["-D", "--debug"], values: ["--context", "-c", "--log-level", "-l"] },
  verbs: {
    ps: DOCKER_PS, images: DOCKER_IMAGES, inspect: DOCKER_INSPECT, logs: DOCKER_LOGS, version: DOCKER_FORMAT,
    info: DOCKER_FORMAT, history: DOCKER_HISTORY, port: {}, top: {}, stats: DOCKER_STATS, diff: {},
    search: { flags: ["--no-trunc"], values: ["-f", "--filter", "--format", "--limit"] },
    image: { sub: { ls: DOCKER_IMAGES, list: DOCKER_IMAGES, inspect: DOCKER_INSPECT, history: DOCKER_HISTORY } },
    container: {
      sub: {
        ls: DOCKER_PS, list: DOCKER_PS, inspect: DOCKER_INSPECT, logs: DOCKER_LOGS, port: {}, top: {}, stats: DOCKER_STATS,
        diff: {},
      },
    },
    network: { sub: { ls: DOCKER_LIST, list: DOCKER_LIST, inspect: DOCKER_FORMAT } },
    volume: { sub: { ls: DOCKER_LIST, list: DOCKER_LIST, inspect: DOCKER_FORMAT } },
    system: { sub: { df: { flags: ["-v", "--verbose"], values: ["--format"] }, info: DOCKER_FORMAT } },
    context: { sub: { ls: DOCKER_LIST, list: DOCKER_LIST, inspect: DOCKER_FORMAT, show: {} } },
  },
};

const GH_JSON = ["--json", "-q", "--jq", "-t", "--template"];
const GH_REPO = ["-R", "--repo"];
const GH_LIST = ["-L", "--limit", "-S", "--search", "-l", "--label", "-a", "--assignee", "-A", "--author", "-s", "--state"];
const GH: SubcommandReaders = {
  // No --web/-w anywhere (a browser), no api/checkout/download.
  global: {},
  verbs: {
    pr: {
      sub: {
        view: { flags: ["-c", "--comments"], values: [...GH_JSON, ...GH_REPO] },
        list: { flags: ["-d", "--draft"], values: [...GH_LIST, ...GH_JSON, ...GH_REPO, "-B", "--base", "-H", "--head"] },
        diff: { flags: ["--patch", "--name-only"], values: ["--color", ...GH_REPO] },
        status: { flags: ["-c", "--conflict-status"], values: [...GH_JSON, ...GH_REPO] },
        checks: { flags: ["--watch", "--required", "--fail-fast"], values: ["-i", "--interval", ...GH_JSON, ...GH_REPO] },
      },
    },
    issue: {
      sub: {
        view: { flags: ["-c", "--comments"], values: [...GH_JSON, ...GH_REPO] },
        list: { values: [...GH_LIST, ...GH_JSON, ...GH_REPO, "-m", "--milestone", "--mention"] },
        status: { values: [...GH_JSON, ...GH_REPO] },
      },
    },
    repo: {
      sub: {
        view: { values: ["-b", "--branch", ...GH_JSON] },
        list: { flags: ["--fork", "--source", "--archived", "--no-archived"], values: ["-L", "--limit", "--visibility", "--language", "--topic", ...GH_JSON] },
      },
    },
    run: {
      sub: {
        view: { flags: ["--log", "--log-failed", "-v", "--verbose", "--exit-status"], values: ["-j", "--job", "-a", "--attempt", ...GH_JSON, ...GH_REPO] },
        list: { values: ["-L", "--limit", "-w", "--workflow", "-b", "--branch", "-u", "--user", "-s", "--status", "-e", "--event", "-c", "--commit", ...GH_JSON, ...GH_REPO] },
      },
    },
    release: {
      sub: {
        view: { values: [...GH_JSON, ...GH_REPO] },
        list: { flags: ["--exclude-drafts", "--exclude-pre-releases"], values: ["-L", "--limit", ...GH_JSON, ...GH_REPO] },
      },
    },
    workflow: {
      sub: {
        view: { flags: ["-y", "--yaml"], values: ["-r", "--ref", ...GH_REPO] },
        list: { flags: ["-a", "--all"], values: ["-L", "--limit", ...GH_JSON, ...GH_REPO] },
      },
    },
    search: {
      sub: Object.fromEntries(["repos", "issues", "prs", "code", "commits"].map((kind) =>
        [kind, { values: ["-L", "--limit", "--owner", ...GH_REPO, ...GH_JSON, "--language", "--state", "--sort", "--order"] }])),
    },
    label: { sub: { list: { values: ["-L", "--limit", "-S", "--search", "--sort", "--order", ...GH_JSON, ...GH_REPO] } } },
    auth: { sub: { status: { flags: ["--active"], values: ["-h", "--hostname"] } } },
    status: { values: ["-o", "--org", "-e", "--exclude"] },
  },
};

const PIP: SubcommandReaders = {
  // Not --python (re-executes pip under it), --log/--cache-dir/--src (write),
  // --index-url/--cert/--client-cert and other network or file options.
  global: { flags: ["-q", "--quiet", "-v", "--verbose", "--no-color", "--disable-pip-version-check", "--isolated"] },
  verbs: {
    list: {
      flags: ["-o", "--outdated", "-u", "--uptodate", "-e", "--editable", "-l", "--local", "--user", "--not-required",
        "--exclude-editable", "--include-editable", "--pre"],
      values: ["--format", "--exclude"],
    },
    show: { flags: ["-f", "--files"] },
    freeze: { flags: ["-l", "--local", "--user", "--all", "--exclude-editable"], values: ["--exclude"] },
    check: {},
    inspect: { flags: ["--local", "--user"] },
    help: {},
    config: { sub: { list: { flags: ["--user", "--global", "--site"] }, get: { flags: ["--user", "--global", "--site"] } } },
  },
};

/**
 * A brew operand that is a path or URL, not a formula name: Homebrew loads a
 * formula from it, and a formula is Ruby. `user/tap/formula` names stay names.
 */
function brewPathOperand(arg: string): boolean {
  if (/^[.~\/]/.test(arg) || /\.rb$/i.test(arg) || arg.includes("://") || arg.includes("..")) return true;
  return arg.includes("/") && !/^[\w-]+\/[\w-]+\/[\w@.+-]+$/.test(arg);
}

const BREW_KIND = ["--formula", "--formulae", "--cask", "--casks"];
const BREW: SubcommandReaders = {
  global: { flags: ["-q", "--quiet", "-v", "--verbose", "-d", "--debug"] },
  // Not outdated/upgrade/tap/update (auto-update or writes); not info --github (a browser).
  verbs: {
    list: { flags: [...BREW_KIND, "-1", "-l", "--versions", "--pinned", "--full-name", "--multiple"] },
    ls: { flags: [...BREW_KIND, "-1", "-l", "--versions", "--pinned", "--full-name", "--multiple"] },
    info: { flags: [...BREW_KIND, "--installed", "--json"], values: ["--json"] },
    abv: { flags: [...BREW_KIND, "--installed", "--json"], values: ["--json"] },
    search: { flags: [...BREW_KIND, "--desc"] },
    deps: {
      flags: [...BREW_KIND, "--tree", "--installed", "--direct", "--topological", "-1", "--include-build", "--include-test",
        "--annotate", "--full-name"],
    },
    uses: { flags: [...BREW_KIND, "--installed", "--recursive"] },
    leaves: { flags: ["-r", "--installed-on-request", "-p", "--installed-as-dependency"] },
    desc: { flags: [...BREW_KIND, "--search", "--name", "--description"] },
    config: {},
    doctor: {},
    commands: { flags: ["--include-aliases"] },
    "--prefix": { flags: ["--installed"] },
    "--cellar": {},
    "--repository": {},
    "--repo": {},
    "--cache": {},
    "--caskroom": {},
    "--env": {},
  },
  badOperand: brewPathOperand,
};

/**
 * bat prints files: listed display options only (no pager, config or cache
 * option), and never the `cache` subcommand.
 */
const BAT_FLAGS = ["-p", "-pp", "--plain", "-n", "--number", "-A", "--show-all", "-P", "--paging=never", "-d", "--diff",
  "-S", "--chop-long-lines", "--list-languages", "--list-themes"];
const BAT_VALUES = ["-l", "--language", "-r", "--line-range", "-H", "--highlight-line", "--style", "--theme", "--color",
  "--tabs", "--wrap", "--terminal-width", "--decorations", "-m", "--map-syntax"];
function batReads(args: readonly string[]): boolean {
  let operands = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return true;
    if (arg.startsWith("-") && arg !== "-") {
      const end = allowedOption(args, i, { flags: BAT_FLAGS, values: BAT_VALUES });
      if (end === -1) return false;
      i = end;
      continue;
    }
    if (operands++ === 0 && arg === "cache") return false;
  }
  return true;
}

/** curl options that only shape an http(s) GET or its console output (R43). */
const CURL_FLAGS = ["--silent", "--show-error", "--location", "--head", "--include", "--fail", "--compressed"];
const CURL_FLAG_LETTERS = /^-[sSLIif]+$/;
const CURL_VALUES = ["-m", "--max-time", "-A", "--user-agent", "-H", "--header"];

/**
 * An http(s) fetch printed to stdout. Every operand must be an http:// or
 * https:// URL (no file:, telnet:, gopher:, dict:, ...), and every option
 * must be listed; a value starting with `@` (curl reads that file) is not.
 * Anything else — an output, header, cookie or config file, a request body
 * or upload, another method — is not a known read. Stdin fed to curl is
 * refused by the caller. Residual: any allowed GET can still carry data out
 * in its URL; that is inherent to allowing network reads at all.
 */
function curlReads(args: readonly string[]): boolean {
  let urls = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("-")) {
      if (CURL_FLAGS.includes(arg) || CURL_FLAG_LETTERS.test(arg)) continue;
      if (!CURL_VALUES.includes(arg)) return false;
      const value = args[++i];
      if (value === undefined || value.startsWith("@")) return false;
      if ((arg === "-m" || arg === "--max-time") && !/^\d+(?:\.\d+)?$/.test(value)) return false;
      continue;
    }
    if (!/^https?:\/\//i.test(arg)) return false;
    urls++;
  }
  return urls > 0;
}

/**
 * Multi-mode tools whose read forms pass the allowlist inversion. Each
 * predicate gets the argv after the head; true means a known read. Git
 * (git.ts) and npm/pnpm/cargo/go (repo-scripts.ts) keep their own verb
 * tables. These tools read configuration from their environment
 * (KUBECONFIG, DOCKER_HOST, PIP_*, CURL_HOME, BAT_CONFIG_PATH, ...), so the
 * caller refuses them when the command assigns or exports anything (R43).
 * wget is not here: it writes an HSTS file or its download every time.
 */
export const READ_ONLY_SUBCOMMANDS: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
  curl: curlReads,
  crontab: (args) => args.length === 1 && args[0] === "-l",
  bat: batReads,
  batcat: batReads,
  kubectl: (args) => subcommandReads(KUBECTL, args),
  docker: (args) => subcommandReads(DOCKER, args),
  gh: (args) => subcommandReads(GH, args),
  pip: (args) => subcommandReads(PIP, args),
  pip3: (args) => subcommandReads(PIP, args),
  brew: (args) => subcommandReads(BREW, args),
};

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
  /** Classify shell TEXT (a `watch 'cmd'` body that `sh -c` will parse). */
  inspectText: (text: string) => string | null;
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

/**
 * Whether setting `name` (to `value`, or to an unknown value) makes `less`
 * run a command or write: LESSOPEN/LESSCLOSE are input preprocessors, lesskey
 * sources can set them, and $LESS holds options parsed like argv.
 */
export function lessEnvironmentWrite(name: string, value: string | undefined): boolean {
  if (name === "LESSOPEN" || name === "LESSCLOSE" || name.startsWith("LESSKEY")) return true;
  if (name !== "LESS") return false;
  if (value === undefined) return true;
  // $LESS options may omit the leading dash (`LESS=FRX`).
  const words = value.split(/\s+/).filter(Boolean).map((word) => /^[-+]/.test(word) ? word : `-${word}`);
  return lessArgvWrite(words) !== null;
}

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
export const READ_ONLY_HEAD_WRITES: Record<string, ReadOnlyHeadWriteCheck> = {
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
  // -x/--exec and -X/--exec-batch run a command per result. A short cluster
  // holding x/X stops even when it is an option value (`-tx`): fail closed.
  fd: fdWrite,
  fdfind: fdWrite,
  // R44: an option allowlist. -C/--compile writes, -m/--magic-file loads a
  // magic source, -z/-Z run decompressors, -p restores (writes) access times,
  // -S drops the sandbox; long options are matched exactly (no abbreviations).
  file: fileWrite,
  date: dateWrite,
  // Any operand, -F FILE, or any long option (`--file=`, abbreviable) may set the host name.
  hostname: (args) => (args.some((arg) => !arg.startsWith("-") || arg.startsWith("--") || /^-[^-]*F/.test(arg)) ? "hostname set" : null),
  // BSD/macOS base64 writes -o/--output FILE.
  base64: (args) => {
    for (const arg of args) {
      if (arg === "--") break;
      if (/^--output(?:=|$)/.test(arg) || (/^-[^-]/.test(arg) && arg.includes("o"))) return "base64 -o";
    }
    return null;
  },
  // GNU iconv writes -o/--output FILE; -f/-t take the rest of a cluster.
  iconv: (args) => {
    for (const arg of args) {
      if (arg === "--") break;
      if (/^--output(?:=|$)/.test(arg)) return "iconv --output";
      if (!/^-[^-]/.test(arg)) continue;
      for (const letter of arg.slice(1)) {
        if (letter === "o") return "iconv -o";
        if (letter === "f" || letter === "t") break;
      }
    }
    return null;
  },
  bat: batWrite,
  batcat: batWrite,
  // -C runs a callback command every -c lines.
  mapfile: mapfileWrite,
  readarray: mapfileWrite,
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
          // A trailing lone `\` is a `\;` cut at the `;` by a splitter that
          // ignored escapes. splitCommandSegments honors them now (CORE-7), so
          // this should not trigger; it stays as the fail-closed guard (R11a).
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
      if (name !== undefined && lessEnvironmentWrite(name, isAppendAssignment(assignment) ? undefined : value)) return name;
    }
    return lessArgvWrite(args);
  },
  uniq: uniqWrite,
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

const UNIQ_GETOPT: GetoptSpec = {
  short: { c: "flag", d: "flag", D: "flag", f: "value", i: "flag", s: "value", u: "flag", w: "value", z: "flag" },
  long: {
    count: "flag", repeated: "flag", "all-repeated": "optional", "skip-fields": "value", group: "optional",
    "ignore-case": "flag", "skip-chars": "value", unique: "flag", "zero-terminated": "flag", "check-chars": "value",
    help: "flag", version: "flag",
  },
};

/** procps-ng watch. `-s/--shotsdir` writes screenshots; `-x` execs argv instead of `sh -c`. */
const WATCH_GETOPT: GetoptSpec = {
  short: {
    b: "flag", c: "flag", C: "flag", d: "optional", e: "flag", g: "flag", n: "value", p: "flag", q: "value",
    r: "flag", s: "value", t: "flag", w: "flag", x: "flag", h: "flag", v: "flag",
  },
  long: {
    beep: "flag", color: "flag", "no-color": "flag", differences: "optional", errexit: "flag", chgexit: "flag",
    interval: "value", precise: "flag", equexit: "value", "no-rerun": "flag", shotsdir: "value", "no-title": "flag",
    "no-wrap": "flag", exec: "flag", help: "flag", version: "flag",
  },
  stopAtOperand: true,
};

/**
 * GNU/bsd tar modes and options that write, delete or run a program. Long
 * options may be abbreviated, so any unambiguous-or-not prefix of one of these
 * names counts (over-blocking an ambiguous abbreviation tar would reject).
 */
const TAR_WRITE_LONG = [
  "create", "extract", "get", "update", "append", "concatenate", "catenate", "delete", "remove-files",
  "to-command", "use-compress-program", "info-script", "new-volume-script", "checkpoint-action",
  // Write a listing/volume-number file, or run a remote-shell/rmt program.
  "index-file", "volno-file", "rsh-command", "rmt-command",
];
/** Short/bundled letters: c/x/u/r/A modes, -I compress program, -F info script. */
const TAR_WRITE_LETTERS = /[cxurAIF]/;

function tarWrite(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0]!;
      if (name.length > 0 && TAR_WRITE_LONG.some((long) => long.startsWith(name))) return `tar --${name}`;
      continue;
    }
    // Old-style bundled first word (`tar xvf a.tar`), or a dash cluster. A
    // letter taking a value (`f`, `C`, `T`, `X`, `b`, `N`, `K`, `L`, `V`, `g`)
    // ends the cluster's option letters in dash form (`-fx.tar` names a file).
    const cluster = i === 0 && !arg.startsWith("-") ? arg : arg.startsWith("-") && arg !== "-" ? arg.slice(1) : null;
    if (cluster === null) continue;
    for (const letter of cluster) {
      if (TAR_WRITE_LETTERS.test(letter)) return `tar -${letter}`;
      if (arg.startsWith("-") && "fCTXbNKLVg".includes(letter)) break;
    }
  }
  return null;
}

/** unzip extracts unless a list/test/pipe/comment/zipinfo mode is given. */
function unzipWrite(args: string[]): string | null {
  for (const arg of args) {
    if (arg === "--") break;
    if (/^-[^-]/.test(arg) && /[ltvpzZ]/.test(arg.slice(1))) return null;
  }
  return "unzip";
}

/**
 * gzip-family compressors replace their file operands in place unless writing
 * to stdout, testing or listing. With no file operand they filter stdin to
 * stdout. zstd's `-o FILE` writes and `--rm` deletes the source either way.
 */
function compressorWrite(head: string, args: string[]): string | null {
  let readOnlyMode = false;
  let operands = 0;
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!endOfOptions && arg === "--") { endOfOptions = true; continue; }
    if (!endOfOptions && arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0]!;
      if (head === "zstd" && (name === "rm" || name === "output")) return `zstd --${name}`;
      if (["stdout", "to-stdout", "test", "list", "help", "version"].includes(name)) readOnlyMode = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-") && arg !== "-") {
      if (head === "zstd" && arg.slice(1).includes("o")) return "zstd -o";
      // Short clusters: -c stdout, -t test, -l list, -h/-V help/version. A
      // level or thread count (`-9`, `-T0`) holds no mode letter.
      if (/[ctlhV]/.test(arg.slice(1))) readOnlyMode = true;
      continue;
    }
    if (arg !== "-") operands++;
  }
  return readOnlyMode || operands === 0 ? null : head;
}

/**
 * Environment variables man reads a command or options from: its pager
 * (MANPAGER, then PAGER), its default options (MANOPT, which may hold `-P`),
 * and the browser `-H` runs.
 */
export const MAN_COMMAND_ENV: ReadonlySet<string> = new Set(["MANPAGER", "PAGER", "MANOPT", "BROWSER"]);
const MAN_EXEC_LONG = ["pager", "html", "config-file"];

/**
 * man runs a pager (`-P`/`--pager`), a browser (`-H`/`--html`), or whatever a
 * config file (`-C`) defines. Short clusters are not split into values: any
 * cluster holding P/H/C stops, which can only over-stop.
 */
function manWrite(args: string[], { assignments }: ReadOnlyHeadContext): string | null {
  for (const assignment of assignments) {
    const name = ENV_ASSIGNMENT_RE.exec(assignment)?.[1];
    if (name && MAN_COMMAND_ENV.has(name)) return name;
  }
  for (const arg of args) {
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const name = arg.slice(2).split("=")[0]!;
      if (name.length > 0 && MAN_EXEC_LONG.some((long) => long.startsWith(name))) return `man --${name}`;
      continue;
    }
    if (/^-[^-]/.test(arg) && /[PHC]/.test(arg.slice(1))) return `man ${arg}`;
  }
  return null;
}

/**
 * vi-family editors run ex commands from `-c`/`+cmd`/`--cmd`/`-S`, their
 * vimrc/exrc and modelines, and write any buffer: only an info-only
 * invocation is read-only.
 */
const VIM_INFO_FLAGS = new Set(["--version", "--help", "-h"]);
function vimWrite(head: string, args: string[]): string | null {
  return args.length > 0 && args.every((arg) => VIM_INFO_FLAGS.has(arg)) ? null : head;
}

/** util-linux flock: `flock [OPTS] FILE|DIR -c CMD`, `flock [OPTS] FILE|DIR CMD [ARG]...`, `flock [OPTS] FD`. */
const FLOCK_GETOPT: GetoptSpec = {
  short: {
    s: "flag", e: "flag", x: "flag", u: "flag", n: "flag", o: "flag", F: "flag", w: "value", E: "value",
    c: "value", h: "flag", V: "flag",
  },
  long: {
    shared: "flag", exclusive: "flag", unlock: "flag", nonblock: "flag", nb: "flag", close: "flag",
    "no-fork": "flag", timeout: "value", wait: "value", "conflict-exit-code": "value", command: "value",
    verbose: "flag", help: "flag", version: "flag",
  },
  stopAtOperand: true,
};

/** flock runs its command (`sh -c` text, or an argv) under the lock; that command is classified in turn. */
function flockWrite(args: string[], { inspect, inspectText }: ReadOnlyHeadContext): string | null {
  const items = getopt(args, FLOCK_GETOPT);
  if (items === null) return "flock option";
  const operands = items.filter((item) => item.kind === "operand").map((item) => item.value);
  const rest = operands.slice(1);
  let nested: string | null = null;
  const commandOption = optionNamed(items, ["c", "command"]);
  if (rest.length > 0 && /^(?:-c|--command)$/.test(rest[0]!)) {
    if (rest.length < 2) return "flock -c";
    nested = inspectText(rest[1]!);
  } else if (rest.length > 0 && /^(?:-c|--command=)/.test(rest[0]!)) {
    return "flock -c";
  } else if (rest.length > 0) {
    nested = inspect(rest);
  } else if (commandOption) {
    nested = inspectText((commandOption as { value: string }).value);
  }
  return nested ? `flock ${nested}` : null;
}

/** Heads that only ever create or write files (outside --help/--version). */
const PLAIN_WRITERS = ["split", "csplit", "mkfifo"];
const WRITER_INFO_FLAGS = new Set(["--help", "--version"]);

/**
 * Heads outside READ_ONLY_HEADS whose writes the word scan cannot see: each
 * returns the offending token, or null for its read-only modes. Unlike
 * READ_ONLY_HEAD_WRITES, a null here does not skip the word scan.
 */
export const WRITER_HEAD_MODES: Record<string, ReadOnlyHeadWriteCheck> = {
  tar: tarWrite,
  bsdtar: tarWrite,
  gtar: tarWrite,
  unzip: unzipWrite,
  gzip: (args) => compressorWrite("gzip", args),
  gunzip: (args) => compressorWrite("gunzip", args),
  bzip2: (args) => compressorWrite("bzip2", args),
  bunzip2: (args) => compressorWrite("bunzip2", args),
  xz: (args) => compressorWrite("xz", args),
  unxz: (args) => compressorWrite("unxz", args),
  zstd: (args) => compressorWrite("zstd", args),
  unzstd: (args) => compressorWrite("unzstd", args),
  man: manWrite,
  flock: flockWrite,
  ...Object.fromEntries(["vi", "vim", "view", "ex", "nvim", "vimdiff", "rvim", "rview", "gvim"].map(
    (head): [string, ReadOnlyHeadWriteCheck] => [head, (args) => vimWrite(head, args)],
  )),
  ...Object.fromEntries(PLAIN_WRITERS.map(
    (head): [string, ReadOnlyHeadWriteCheck] => [head, (args) => (args.length === 1 && WRITER_INFO_FLAGS.has(args[0]!) ? null : head)],
  )),
  // `patch` applies to files (from stdin or -i) unless it is a dry run.
  patch: (args) => (args.includes("--dry-run") ? null : "patch"),
  // A database shell: any statement or dot-command may write the database or
  // a file (`.output`, `.backup`), and statements can come from stdin.
  sqlite3: () => "sqlite3",
  // `script` records the session to a typescript file (default ./typescript).
  script: () => "script",
  // watch runs its command repeatedly: `sh -c` on the joined words, or the
  // argv itself with -x. That command is classified in turn.
  watch: (args, { inspect, inspectText }) => {
    const items = getopt(args, WATCH_GETOPT);
    if (items === null) return "watch option";
    if (optionNamed(items, ["s", "shotsdir"])) return "watch --shotsdir";
    const command = items.filter((item) => item.kind === "operand").map((item) => item.value);
    if (command.length === 0) return null;
    const nested = optionNamed(items, ["x", "exec"]) ? inspect(command) : inspectText(command.join(" "));
    return nested ? `watch ${nested}` : null;
  },
};

/**
 * bat runs a pager (--pager, --paging=always, or one named by its
 * environment/config) and `bat cache --build` writes its cache. Any
 * environment assignment on the invocation (BAT_PAGER, PAGER,
 * BAT_CONFIG_PATH, LESSOPEN, ...) stops too.
 */
function batWrite(args: string[], { assignments }: ReadOnlyHeadContext): string | null {
  if (assignments.length > 0) return "bat environment";
  for (const arg of args) {
    if (arg === "--") break;
    if (/^--pag(?:er|ing)(?:=|$)/.test(arg) && arg !== "--paging=never") return `bat ${arg.split("=")[0]}`;
    if (/^--(?:config-file|config-dir|cache-dir)(?:=|$)/.test(arg)) return `bat ${arg.split("=")[0]}`;
  }
  const operand = args.find((arg) => !arg.startsWith("-"));
  return operand === "cache" ? "bat cache" : null;
}

/**
 * date sets the clock with -s/--set, or with a positional date operand (GNU
 * `MMDDhhmm…`, BSD `[[cc]yy]mmddHHMM` and `-f FMT STR`) unless BSD -j says
 * "parse only". A `+FORMAT` operand only formats. Unknown options stop.
 */
const DATE_FLAGS = new Set(["-u", "--utc", "--universal", "-R", "--rfc-email", "-j", "-n", "--debug", "-I"]);
const DATE_VALUES = new Set(["-d", "--date", "-f", "--file", "-r", "--reference", "-v", "-z"]);
function dateWrite(args: string[]): string | null {
  const parseOnly = args.includes("-j");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("+")) continue;
    if (/^-I[a-z]*$|^--iso-8601(?:=|$)|^--rfc-3339=/.test(arg)) continue;
    // BSD -v adjusts the displayed date (`-v-1d`); -r/-z/-d may be attached.
    if (/^-[vrzd]./.test(arg)) continue;
    if (arg === "-s" || /^--set(?:=|$)/.test(arg) || /^-[^-]*s/.test(arg)) return "date -s";
    if (!arg.startsWith("-")) {
      if (!parseOnly) return "date set";
      continue;
    }
    const name = arg.split("=")[0]!;
    if (DATE_FLAGS.has(arg)) continue;
    if (DATE_VALUES.has(name)) {
      if (!arg.includes("=")) i++;
      continue;
    }
    return `date ${arg}`;
  }
  return null;
}

const FILE_FLAG_LETTERS = "bcdEhiIkLlNnrs0v";
const FILE_VALUE_LETTERS = "eFPf";
const FILE_LONG_FLAGS = new Set([
  "--brief", "--debug", "--no-dereference", "--dereference", "--mime", "--mime-type", "--mime-encoding", "--keep-going",
  "--list", "--no-pad", "--no-buffer", "--raw", "--special-files", "--print0", "--version", "--help", "--extension",
  "--apple", "--checking-printout",
]);
const FILE_LONG_VALUES = new Set(["--exclude", "--exclude-quiet", "--separator", "--parameter", "--files-from"]);
function fileWrite(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg.startsWith("--")) {
      const name = arg.split("=")[0]!;
      if (FILE_LONG_FLAGS.has(arg)) continue;
      if (FILE_LONG_VALUES.has(name)) {
        if (!arg.includes("=")) i++;
        continue;
      }
      return `file ${name}`;
    }
    if (!arg.startsWith("-") || arg === "-") continue;
    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j]!;
      if (FILE_VALUE_LETTERS.includes(letter)) {
        if (j === arg.length - 1) i++;
        break;
      }
      if (!FILE_FLAG_LETTERS.includes(letter)) return `file -${letter}`;
    }
  }
  return null;
}

function mapfileWrite(args: string[]): string | null {
  for (const arg of args) {
    if (arg === "--") break;
    if (/^-[^-]/.test(arg) && arg.includes("C")) return "mapfile -C";
  }
  return null;
}

function fdWrite(args: string[]): string | null {
  for (const arg of args) {
    if (arg === "--") break;
    if (/^--exec(?:-batch)?(?:=|$)/.test(arg)) return `fd ${arg.split("=")[0]}`;
    if (/^-[^-]/.test(arg) && /[xX]/.test(arg)) return "fd -x";
  }
  return null;
}

/** uniq writes its second operand: `uniq [OPTION]... [INPUT [OUTPUT]]`. */
function uniqWrite(args: string[]): string | null {
  const items = getopt(args, UNIQ_GETOPT);
  if (items === null) return "uniq option";
  return items.filter((item) => item.kind === "operand").length > 1 ? "uniq outfile" : null;
}
