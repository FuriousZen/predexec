/**
 * D1: interpreters and task runners running repository files.
 *
 * `python3 script.py`, `node x.js`, `npm run lint`, `make`, `cargo run` and
 * `./build.sh` all run code the repository controls; nothing the classifier
 * sees on the command line can vouch for what that code does. Such an
 * invocation is mutating by default. The user may lift exactly this stop for
 * exact command prefixes or script paths (ClassifierOptions.allowScripts,
 * loaded from user-level config only — see user-config.ts); every other rule
 * still classifies the command.
 *
 * Inline programs (`python3 -c`, `node -e`) are NOT D1: the eval scanners and
 * reader allowlists in destructive.ts vet them. Neither are programs read
 * from stdin: the stdin-program rule already stops those.
 */

import { ARGV, lexShellWords, normalizeEnvInvocation, tokenizeShellWords } from "./lexer.ts";
import { EVAL_INTERPRETERS, interpreterEvalPrograms, interpreterFamily } from "./interpreters.ts";
import { SYSTEM_PREFIXES } from "./env.ts";

export interface RepositoryScriptRun {
  /** The decoded argv after wrappers and assignments (`env X=1` dropped). */
  argv: string[];
  /** The script path or module the interpreter runs, when there is one. */
  script: string | null;
}

/** Every argument is one of `flags` (and there is at least one). */
const onlyFlags = (args: readonly string[], flags: ReadonlySet<string>): boolean =>
  args.length > 0 && args.every((arg) => flags.has(arg));

const VERSION_HELP = new Set(["--version", "-V", "-v", "--help", "-h"]);

/**
 * Stdlib modules `python3 -m` may run: they import nothing from the repo on
 * their own. The check gets the module's arguments.
 */
const PYTHON_READER_MODULES: Readonly<Record<string, (args: readonly string[]) => boolean>> = {
  // `json.tool INFILE OUTFILE` writes OUTFILE: at most one operand.
  "json.tool": (args) => {
    let operands = 0;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--") { operands += args.length - i - 1; break; }
      if (arg === "--indent") i++;
      else if (!arg.startsWith("-") || arg === "-") operands++;
    }
    return operands <= 1;
  },
};

/**
 * R62: the options an interpreter takes before its script operand without a
 * value. A one-word allowScripts entry names the script, so the operand must
 * be certain: any value-taking option (attached or separate — `-I dir`,
 * `-Ilib`, `-r mod`, `--require=x`, which also loads another file) or any
 * option not listed here means no script is named (fail closed). An exact
 * argv-prefix entry still matches.
 */
interface OperandGrammar {
  /** Short-option letters that take no value, clusterable. */
  shortLetters: string;
  /** Long options that take no value. */
  long: ReadonlySet<string>;
}

const OPERAND_GRAMMARS: Readonly<Record<string, OperandGrammar>> = {
  python: {
    shortLetters: "bBdEhiIOPqRsSuvVx",
    long: new Set(["--version", "--help", "--help-env", "--help-xoptions", "--help-all"]),
  },
  perl: { shortLetters: "acnpsStTuUvwWXh", long: new Set() },
  ruby: {
    shortLetters: "acdhlnpsSvwy",
    long: new Set(["--verbose", "--version", "--copyright", "--yydebug", "--help", "--jit", "--yjit"]),
  },
  node: {
    shortLetters: "",
    long: new Set([
      "--no-warnings", "--trace-warnings", "--enable-source-maps", "--experimental-strip-types",
      "--no-experimental-strip-types", "--experimental-transform-types", "--no-deprecation", "--trace-deprecation",
      "--throw-deprecation", "--trace-uncaught", "--preserve-symlinks", "--preserve-symlinks-main", "--expose-gc",
      "--abort-on-uncaught-exception", "--experimental-vm-modules",
    ]),
  },
  bun: { shortLetters: "", long: new Set(["--watch", "--hot", "--smol", "--bun", "--silent"]) },
  php: { shortLetters: "nqHlsw", long: new Set() },
};

/**
 * The script operand after the options in `args`, or null when there is none
 * or an option before it is value-taking or unknown to `grammar`.
 */
function certainOperand(args: readonly string[], grammar: OperandGrammar): { index: number } | null {
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (word === "--") return i + 1 < args.length ? { index: i + 1 } : null;
    if (!word.startsWith("-") || word === "-") return { index: i };
    if (word.startsWith("--")) {
      if (grammar.long.has(word)) continue;
      return null;
    }
    for (let j = 1; j < word.length; j++) if (!grammar.shortLetters.includes(word[j]!)) return null;
  }
  return null;
}

/**
 * A python invocation's `-m` module and its arguments, or its script operand
 * (null when not certain, R62 / M2). `-W`/`-X` take a value (attached or the
 * next word); they leave `-m` detection intact but name no script.
 */
function pythonTarget(args: readonly string[]): { module: string; moduleArgs: string[] } | { script: string | null } {
  const grammar = OPERAND_GRAMMARS.python!;
  let valueTaken = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (!word.startsWith("-") || word === "-") return { script: valueTaken ? null : word };
    if (word === "--") return { script: valueTaken ? null : args[i + 1] ?? null };
    if (word.startsWith("--")) {
      if (grammar.long.has(word)) continue;
      return { script: null };
    }
    for (let j = 1; j < word.length; j++) {
      const letter = word[j]!;
      if (letter === "m") {
        const attached = word.slice(j + 1);
        const module = attached || args[++i];
        return module === undefined ? { script: null } : { module, moduleArgs: args.slice(i + 1) };
      }
      if (letter === "W" || letter === "X") {
        valueTaken = true;
        if (j === word.length - 1) i++;
        break;
      }
      if (!grammar.shortLetters.includes(letter)) return { script: null };
    }
  }
  return { script: null };
}

/**
 * An eval-family interpreter (python, node, bun, deno, ruby, perl, php) that
 * runs a script or module, not an inline program or stdin.
 */
function interpreterScript(family: string, segment: string, args: readonly string[]): RepositoryScriptRun["script"] | undefined {
  if (family === "deno") {
    if (onlyFlags(args, VERSION_HELP)) return undefined;
    const sub = args.find((arg) => !arg.startsWith("-"));
    // eval/repl are the inline and stdin rules' to judge; these others run
    // no repository program and write nothing.
    if (sub !== undefined && DENO_NON_RUNNING.has(sub)) return undefined;
    if (sub === undefined || DENO_RUNNING.has(sub)) {
      const at = sub === undefined ? -1 : args.indexOf(sub);
      // R62: `--config x`, `--import-map x` and the like take the next word,
      // so only permission and plain switches may precede a named script.
      const rest = args.slice(at + 1);
      const operand = rest.findIndex((arg) => !DENO_VALUELESS_RE.test(arg));
      return operand === -1 || rest[operand]!.startsWith("-") ? null : rest[operand]!;
    }
    return sub;
  }
  const programs = interpreterEvalPrograms(segment);
  if (programs.kind !== "none" || programs.stdin) return undefined;
  if (onlyFlags(args, family === "php" ? new Set([...VERSION_HELP, "-i", "-m"]) : new Set([...VERSION_HELP, "--revision", "-VV"]))) {
    return undefined;
  }
  if (family === "python" || family === "python3") {
    const target = pythonTarget(args);
    if ("module" in target) {
      const reader = Object.hasOwn(PYTHON_READER_MODULES, target.module) ? PYTHON_READER_MODULES[target.module]! : null;
      // A module is not a script path: a one-word path entry never names it.
      return reader?.(target.moduleArgs) ? undefined : null;
    }
    return target.script;
  }
  const grammar = OPERAND_GRAMMARS[family];
  if (grammar === undefined) return null;
  const operand = certainOperand(args, grammar);
  if (operand === null) return null;
  const script = args[operand.index]!;
  if (family === "bun" && BUN_RUNNING.has(script)) {
    const after = certainOperand(args.slice(operand.index + 1), grammar);
    return after === null ? null : args[operand.index + 1 + after.index]!;
  }
  return script;
}

// Not fmt (rewrites files unless --check, and reads repo config) or lint
// (--fix rewrites; deno.json lint.plugins run repository code).
/** deno options that take no separate value (R62). */
const DENO_VALUELESS_RE = /^(?:--(?:allow|deny)-[a-z-]+(?:=.*)?|-A|--allow-all|-q|--quiet|--no-check|--unstable(?:-[a-z-]+)?|--watch)$/;
const DENO_NON_RUNNING = new Set(["eval", "repl", "check", "info", "doc", "types", "completions", "help"]);
const DENO_RUNNING = new Set(["run", "serve", "test", "bench", "task", "x", "compile", "install", "jupyter"]);
const BUN_RUNNING = new Set(["run", "test", "x", "exec"]);

/**
 * A subcommand-driven package manager/build tool that is read-only only for
 * a known reader subcommand. Global options before the subcommand must be
 * known valueless or carry their value with `=`; otherwise the subcommand
 * position is unknown and the invocation fails closed.
 */
interface SubcommandTool {
  valuelessGlobals: ReadonlySet<string>;
  /**
   * Reader subcommands; a list names the word that must follow at once
   * (`config get`); anything else there is not a read.
   */
  readers: Readonly<Record<string, readonly string[] | null>>;
  /** What a bare invocation (no subcommand) does. */
  bareRuns: boolean;
  /** An argument after a reader subcommand that makes it write or run code. */
  hazard?: (arg: string) => boolean;
}

const SUBCOMMAND_TOOLS: Readonly<Record<string, SubcommandTool>> = {
  npm: {
    valuelessGlobals: new Set(["-g", "--global", "-s", "--silent", "--json", "--long", "--parseable", "--no-color", "--workspaces"]),
    readers: {
      ls: null, list: null, ll: null, la: null, view: null, info: null, show: null, v: null, outdated: null, why: null,
      explain: null, root: null, prefix: null, bin: null, help: null, "help-search": null, search: null, s: null,
      se: null, find: null, fund: null, query: null, whoami: null, ping: null, audit: null,
      config: ["get", "list", "ls"], pkg: ["get"],
    },
    bareRuns: false,
    hazard: (arg) => arg === "fix",
  },
  pnpm: {
    valuelessGlobals: new Set([
      "-r", "--recursive", "-g", "--global", "-w", "--workspace-root", "-s", "--silent", "--json", "--long",
      "--parseable", "--prod", "--dev", "-P", "-D",
    ]),
    readers: {
      ls: null, list: null, ll: null, la: null, why: null, outdated: null, audit: null, root: null, bin: null,
      help: null, view: null, info: null, show: null, v: null, licenses: ["ls", "list"], config: ["get", "list"],
      store: ["path"],
    },
    bareRuns: false,
    hazard: (arg) => arg === "--fix",
  },
  cargo: {
    // Any other subcommand may be a repository alias (`.cargo/config.toml`)
    // or a build that runs build.rs and proc macros; `tree`/`metadata` query
    // the target through `build.rustc`/`build.rustc-wrapper`, which repo
    // config can point at a repository program.
    valuelessGlobals: new Set(["-q", "--quiet", "-v", "-vv", "--verbose", "--locked", "--offline", "--frozen"]),
    readers: {
      version: null, help: null, search: null, "locate-project": null, "verify-project": null, "read-manifest": null,
    },
    bareRuns: false,
  },
  go: {
    valuelessGlobals: new Set(),
    // No `vet` (it can run a -vettool); build flags can name a -toolexec.
    readers: { version: null, env: null, list: null, doc: null, help: null, mod: ["graph", "why", "verify"] },
    bareRuns: false,
    hazard: (arg) => /^--?(?:w|u|toolexec|exec|overlay|modfile)(?:=|$)/.test(arg),
  },
};

function subcommandToolRuns(tool: SubcommandTool, args: readonly string[]): boolean {
  if (onlyFlags(args, VERSION_HELP)) return false;
  let i = 0;
  for (; i < args.length; i++) {
    const word = args[i]!;
    if (!word.startsWith("-") && !word.startsWith("+")) break;
    if (word.startsWith("+") || word.includes("=") || tool.valuelessGlobals.has(word)) continue;
    return true;
  }
  const sub = args[i];
  if (sub === undefined) return tool.bareRuns;
  if (!Object.hasOwn(tool.readers, sub)) return true;
  const second = tool.readers[sub];
  const rest = args.slice(i + 1);
  if (second && !second.includes(rest[0] ?? "")) return true;
  return tool.hazard !== undefined && rest.some(tool.hazard);
}

const JUST_LISTING = new Set([
  "--list", "-l", "--summary", "--dump", "--groups", "--variables", "--version", "-V", "--help", "-h",
]);

/**
 * Tools that run repository-configured code for every invocation, version
 * queries included: yarn execs `.yarnrc.yml` `yarnPath`; composer loads
 * vendor plugins and `pre-command-run` scripts; `mvn` splices
 * `.mvn/jvm.config` into every JVM start; gradle reads the repo's
 * `gradle.properties` JVM args; pytest loads the initial conftest.py while
 * parsing options.
 */
const ALWAYS_RUNS = new Set(["yarn", "composer", "mvn", "gradle", "pytest", "py.test"]);

/** Tools that run repository code for everything but a version/help query. */
const TEST_AND_TASK_RUNNERS = new Set([
  "Rscript", "npx", "pnpx", "bunx", "uvx", "jest", "vitest", "mocha", "ava", "tsx", "ts-node",
  "rake", "tox", "nox", "invoke", "phpunit", "rspec",
]);

/** Environment managers whose `run`/`exec` subcommand runs a repository command. */
const RUN_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  uv: new Set(["run", "tool"]),
  poetry: new Set(["run"]),
  pipenv: new Set(["run"]),
  hatch: new Set(["run"]),
  pdm: new Set(["run"]),
  rye: new Set(["run"]),
  bundle: new Set(["exec"]),
};

function taskRunnerRuns(head: string, args: readonly string[]): boolean {
  if (ALWAYS_RUNS.has(head)) return true;
  if (TEST_AND_TASK_RUNNERS.has(head)) return !onlyFlags(args, VERSION_HELP);
  // make reads the Makefile for any target, dry runs included: `-n`/`-q`
  // still expand `$(shell …)` while parsing and run `+` recipes (R34).
  if (head === "make" || head === "gmake" || head === "bmake") return !onlyFlags(args, VERSION_HELP);
  if (head === "just") {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--show" || args[i] === "-s") { i++; continue; }
      if (!JUST_LISTING.has(args[i]!)) return true;
    }
    return args.length === 0;
  }
  if (Object.hasOwn(RUN_SUBCOMMANDS, head)) {
    return args.some((arg) => RUN_SUBCOMMANDS[head]!.has(arg));
  }
  if (Object.hasOwn(SUBCOMMAND_TOOLS, head)) return subcommandToolRuns(SUBCOMMAND_TOOLS[head]!, args);
  return false;
}

/**
 * Heads whose every invocation taskRunnerRuns decides: a run is a D1 stop,
 * anything else is one of the tool's known reads (its version/help, a
 * listing, a reader subcommand). The allowlist inversion takes D1's verdict
 * for these. Not the RUN_SUBCOMMANDS tools: D1 only judges their `run`.
 */
export function governedByRepositoryScripts(head: string): boolean {
  return ALWAYS_RUNS.has(head) || TEST_AND_TASK_RUNNERS.has(head) || Object.hasOwn(SUBCOMMAND_TOOLS, head) ||
    head === "make" || head === "gmake" || head === "bmake" || head === "just";
}

/** An unquoted redirection operator at the start of a word's source text (not `<(`/`>(`). */
const REDIRECT_OPERATOR_RE = /^(?:\d+|\{\w+\})?(?:<<<|<<-?|<>|<&|>&|>>|>\||&>>|&>|<(?!\()|>(?!\())/;

/**
 * The simple command without its redirections (`python3 x.py < in 2>/dev/null`
 * is `python3 x.py`): a redirection's operator and target are not arguments.
 */
function withoutRedirections(segment: string): string {
  const kept: string[] = [];
  const { words } = lexShellWords(segment, ARGV);
  for (let i = 0; i < words.length; i++) {
    const source = segment.slice(words[i]!.start, words[i]!.end);
    const operator = REDIRECT_OPERATOR_RE.exec(source);
    if (!operator) { kept.push(source); continue; }
    if (operator[0] === source) i++;
  }
  return kept.join(" ");
}

/** A path head that may be a repository file: relative, `~`, or absolute outside SYSTEM_PREFIXES. */
function maybeRepositoryPath(head: string): boolean {
  if (!head.includes("/")) return false;
  // `..`/`.` segments can climb out of a system prefix (`/usr/../Users/…`).
  if (/(?:^|\/)\.\.?(?:\/|$)/.test(head)) return true;
  return !SYSTEM_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/**
 * Whether a simple command runs a repository script (D1), and which. Null
 * when it does not, or when its argv cannot be resolved (other rules decide
 * those).
 */
export function repositoryScriptRun(rawSegment: string): RepositoryScriptRun | null {
  const segment = withoutRedirections(rawSegment);
  const tokens = tokenizeShellWords(segment, ARGV);
  // `command -v make` looks the name up; it runs nothing.
  if (tokens[0] === "command" && /^-[vV]+$/.test(tokens[1] ?? "")) return null;
  const normalized = normalizeEnvInvocation(tokens);
  if (!normalized.complete || normalized.argv.length === 0) return null;
  const argv = normalized.argv;
  const rawHead = argv[0]!;
  // A path executable (`./build.sh`, `scripts/run`, `node_modules/.bin/x`,
  // `/abs/repo/build.sh`) outside the system prefixes may be a repository file.
  if (maybeRepositoryPath(rawHead)) return { argv, script: rawHead };
  const head = rawHead.replace(/^.*\//, "");
  const args = argv.slice(1);
  const family = interpreterFamily(head);
  if (EVAL_INTERPRETERS.has(family)) {
    const script = interpreterScript(family, segment, args);
    return script === undefined ? null : { argv, script };
  }
  return taskRunnerRuns(head, args) ? { argv, script: null } : null;
}
