/**
 * Reader allowlists for interpreter eval programs (core/destructive.ts): an
 * inline program is mutating unless every call, import, and module reference
 * it makes is a known reader for its language (READER_ALLOWLISTS).
 */

import {
  type InterpolationLanguage,
  LANGUAGE_CALL_CANDIDATE_BUDGET,
  type LanguageViewDetails,
  captureBarePerlArguments,
  captureLanguageCall,
  decodeStaticMode,
  executableLanguageView,
  splitTopLevelArguments,
} from "./language-scan.ts";

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
export function interpreterReaderViolation(payload: string, language: InterpolationLanguage): string | null {
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
