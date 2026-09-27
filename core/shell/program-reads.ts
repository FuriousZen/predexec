/**
 * File paths an inline interpreter program opens for reading (R27(c)).
 *
 * The classifier (core/destructive.ts) lets an inline program run when every
 * call it makes is on the per-language reader allowlist — and `open('.env')`
 * is a reader. A host read rule (Claude `Read(...)`, Antigravity
 * `read_file(...)`) must still see what that reader names, so this module
 * extracts the path arguments of each language's file-read calls:
 *
 *   python  open / io.open / codecs.open / Path(...)
 *   node    fs.readFile[Sync] / createReadStream / open[Sync] / readdir[Sync]
 *           (via `fs.`, `require('fs').` or a bare destructured name), and
 *           `require('./x.json')`
 *   ruby    File/IO .read/.readlines/.open/.foreach/.binread/.new,
 *           FileUtils.compare_file/identical?/cmp, Dir.glob/entries
 *   perl    open (2- and 3-argument) / sysopen
 *   php     file_get_contents / fopen / file / readfile / scandir / …
 *
 * A path given as a static string literal is returned as that string; any
 * other argument (a variable, an f-string, a concatenation, a keyword
 * argument) makes the result unresolvable, and the caller stops. Programs
 * come from `-c`/`-e` (interpreterEvalPrograms) and from here-strings and
 * heredocs an interpreter reads as its program (commandStdin +
 * interpreterStdinProgram) — the same extraction the classifier uses. Pure
 * TS, harness-neutral: the adapters apply their own rules to the paths.
 */

import {
  ARGV,
  commandStdin,
  effectiveHead,
  inspectCommandSubstitutionTree,
  splitCommandSegments,
  stripLeadingAssignmentsAndWrappers,
  tokenizeShellWords,
} from "./lexer.ts";
import {
  EVAL_INTERPRETERS,
  interpreterEvalPrograms,
  interpreterFamily,
  interpreterLanguage,
  interpreterStdinProgram,
  stripShellControlPrefix,
} from "./interpreters.ts";
import {
  type InterpolationLanguage,
  LANGUAGE_CALL_CANDIDATE_BUDGET,
  captureBarePerlArguments,
  captureLanguageCall,
  executableLanguageView,
  splitTopLevelArguments,
} from "./language-scan.ts";

export interface InlineProgramReads {
  /** Static path literals the programs open, as written (relative to the process cwd). */
  paths: string[];
  /** Why a read's target cannot be known statically; null when every read was a literal. */
  unresolved: string | null;
}

interface Program {
  language: InterpolationLanguage;
  text: string;
}

/** A call whose listed argument positions are paths the program reads. */
interface ReadCall {
  pattern: RegExp;
  /** Argument indexes holding paths (for perl `open`, decided per call). */
  args: readonly number[];
}

const READ_CALLS: Record<InterpolationLanguage, readonly ReadCall[]> = {
  python: [
    { pattern: /(?<![\w.])(?:(?:io|codecs)\s*\.\s*)?open\s*\(/g, args: [0] },
    { pattern: /(?<![\w.])(?:pathlib\s*\.\s*)?Path\s*\(/g, args: [0] },
  ],
  node: [
    {
      pattern:
        /(?:(?<![\w$.])fs\s*\.\s*(?:promises\s*\.\s*)?|\brequire\s*\(\s*\)\s*\.\s*|(?<![\w$.]))(?:readFileSync|readFile|createReadStream|openSync|readdirSync|readdir)\s*\(/g,
      args: [0],
    },
    { pattern: /(?<![\w$.])fs\s*\.\s*(?:promises\s*\.\s*)?open\s*\(/g, args: [0] },
  ],
  ruby: [
    { pattern: /\b(?:File|IO)\s*\.\s*(?:read|readlines|open|foreach|binread|new)\b/g, args: [0] },
    { pattern: /\bFileUtils\s*\.\s*(?:compare_file|identical\?|cmp)/g, args: [0, 1] },
    { pattern: /\bDir\s*\.\s*(?:glob|entries|children|each_child)\b/g, args: [0] },
  ],
  perl: [
    { pattern: /(?<![\w$@%&>:])open\b/g, args: [] },
    { pattern: /(?<![\w$@%&>:])sysopen\b/g, args: [1] },
  ],
  php: [
    {
      pattern: /\b(?:file_get_contents|fopen|file|readfile|scandir|highlight_file|show_source|parse_ini_file|fpassthru)\s*\(/gi,
      args: [0],
    },
  ],
};

/** A static string literal's value, or null when the argument is anything else. */
function staticString(arg: string, language: InterpolationLanguage): string | null {
  let text = arg.trim();
  if (language === "python") {
    const prefix = /^(?:[rRbB]|[rR][bB]|[bB][rR])?(?=['"])/.exec(text);
    if (!prefix) return null;
    text = text.slice(prefix[0].length);
  }
  const quote = text[0];
  if ((quote !== "'" && quote !== '"' && !(quote === "`" && language === "node")) || text.length < 2 || text.at(-1) !== quote) {
    return null;
  }
  const body = text.slice(1, -1);
  if (body.includes(quote) || body.includes("\\")) return null;
  if (quote === "`" && body.includes("${")) return null;
  if (quote === '"') {
    if ((language === "ruby" && body.includes("#{")) || ((language === "perl" || language === "php") && /[$@]/.test(body))) return null;
  }
  return body;
}

/** Perl `open`: the 3-arg form names the path third; the 2-arg form second, after its mode. */
function perlOpenPath(fields: readonly string[]): string | null | "none" {
  if (fields.length >= 3) return staticString(fields[2]!, "perl");
  if (fields.length === 2) {
    const spec = staticString(fields[1]!, "perl");
    if (spec === null) return null;
    const trimmed = spec.trim();
    if (/^(?:>|\+>|\|)|\|$/.test(trimmed) || trimmed === "-") return "none"; // writes/pipes: the writer screens own these
    return trimmed.replace(/^\+?<\s*/, "");
  }
  return null; // 1-arg open reads `$FH`'s package variable
}

function programReads(program: Program, out: string[]): string | null {
  const { language, text } = program;
  const view = executableLanguageView(text, language);
  if (view === null) return `${language} program`;
  const syntax = { hashComments: language !== "node", slashComments: language === "node" || language === "php" };
  let candidates = 0;
  for (const call of READ_CALLS[language]) {
    for (const match of view.matchAll(call.pattern)) {
      if (++candidates > LANGUAGE_CALL_CANDIDATE_BUDGET) return "language call candidate budget";
      const end = match.index! + match[0].length;
      let args: string | null;
      if (view[end - 1] === "(") args = captureLanguageCall(text, end - 1, syntax);
      else {
        let open = end;
        while (open < view.length && /[ \t]/.test(view[open]!)) open++;
        if (view[open] === "(") args = captureLanguageCall(text, open, syntax);
        else if (language === "perl") args = captureBarePerlArguments(text, view, open, syntax, 2);
        else if (language === "ruby" && /[.)\]]/.test(view[open] ?? "")) continue; // `File.open.x`-style chain, no call here
        else args = null;
      }
      if (args === null) return `${match[0].trim()} arguments`;
      const fields = splitTopLevelArguments(args, syntax);
      if (fields === null) return `${match[0].trim()} arguments`;
      if (language === "perl" && call.args.length === 0) {
        const path = perlOpenPath(fields);
        if (path === "none") continue;
        if (path === null) return "open with a non-literal path";
        out.push(path);
        continue;
      }
      for (const index of call.args) {
        const field = fields[index];
        if (field === undefined) return `${match[0].trim()} with no path`;
        const path = staticString(field, language);
        if (path === null) return `${match[0].trim().replace(/\s*\($/, "")}(${field.trim().slice(0, 64)})`;
        out.push(path);
      }
    }
  }
  if (language === "perl") {
    const why = perlArgvReads(text, view, syntax, out);
    if (why !== null) return why;
  }
  if (language === "node") {
    // `require('./x.json')` reads (and parses) that file.
    for (const match of view.matchAll(/(?<![\w$.])require\s*\(/g)) {
      if (++candidates > LANGUAGE_CALL_CANDIDATE_BUDGET) return "language call candidate budget";
      const args = captureLanguageCall(text, match.index! + match[0].length - 1, syntax);
      const name = args === null ? null : staticString(args, "node");
      if (name === null) return "require with a non-literal argument";
      if (name.startsWith(".") || name.startsWith("/")) out.push(name);
    }
  }
  return null;
}

/** Closing delimiter for a perl `qw` opener. */
const QW_CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

/**
 * Perl's `@ARGV` channel (R28/R29): `<>`, `<<>>`, `<ARGV>`, `readline`/`eof`
 * on ARGV and the `-n`/`-p` loops open every element of `@ARGV` as a file,
 * and `@ARGV` can be rewritten in more ways than any list of spellings covers
 * (aliasing through `for`/`map`/`s///`, slices, `@main::ARGV`, symbolic
 * `@{"AR"."GV"}`, …). So instead of enumerating writes, a perl program is
 * accepted only when the RAW text — strings included — mentions `ARGV` solely
 * inside recognized literal list assignments (`@ARGV = (".a", ".b")`,
 * `local @ARGV = qw(a b)`, `local(@ARGV) = …`) or a `<ARGV>` read in code,
 * with the assignments' elements becoming paths
 * for the caller to check; and its code has no symbolic dereference
 * (`@{…}`/`${…}`/`*{…}`/`%{…}`/`&{…}` around anything but a plain identifier,
 * or `@$x`-style), no `eval`, no `do`, no `require`. Anything else is
 * unresolvable. This applies to every perl program, not just ones that read
 * `<>` visibly: a symbolic glob can alias ARGV into any filehandle.
 * Command-line file arguments are shell operands, checked by the caller.
 */
function perlArgvReads(
  text: string,
  view: string,
  syntax: { hashComments: boolean; slashComments: boolean },
  out: string[],
): string | null {
  const dynamic = /\b(?:eval|do|require)\b/.exec(view);
  if (dynamic) return `perl ${dynamic[0]}`;
  if (/[@$%*&]\s*\{(?!\s*\^?[A-Za-z_]\w*\s*\})/.test(view) || /[@%*&]\s*\$|\$\s*\$(?=\s*[\w{$:])/.test(view)) {
    return "perl symbolic dereference";
  }
  if (!text.includes("ARGV")) return null;
  const spans: [number, number][] = [];
  const paths: string[] = [];
  const assignment = /(?<![\w:$@%&*{\\])(?:local\s*(?:\(\s*)?)?(?:\(\s*)?@ARGV(?![\w:])\s*\)?\s*=(?![=~])/g;
  for (const match of text.matchAll(assignment)) {
    let at = match.index! + match[0].length;
    while (at < text.length && /\s/.test(text[at]!)) at++;
    let end: number;
    if (text[at] === "(") {
      const args = captureLanguageCall(text, at, syntax);
      const fields = args === null ? null : splitTopLevelArguments(args, syntax);
      if (args === null || fields === null) return "@ARGV list";
      for (const field of fields) {
        if (field.trim() === "") continue;
        const path = staticString(field, "perl");
        if (path === null) return `@ARGV element ${field.trim().slice(0, 64)}`;
        paths.push(path);
      }
      end = at + args.length + 2;
    } else {
      const qw = /^qw\s*(\S)/.exec(text.slice(at));
      if (!qw) return "@ARGV assigned a computed list";
      const close = QW_CLOSERS[qw[1]!] ?? qw[1]!;
      const bodyStart = at + qw[0].length;
      const closeAt = text.indexOf(close, bodyStart);
      if (closeAt === -1) return "@ARGV qw list";
      paths.push(...text.slice(bodyStart, closeAt).split(/\s+/).filter((word) => word !== ""));
      end = closeAt + 1;
    }
    // The literal list must be the whole right-hand side (`(".e") . "nv"` is not).
    if (!/^\s*(?:;|\}|$)/.test(text.slice(end))) return "@ARGV assigned a computed list";
    spans.push([match.index!, end]);
  }
  // `<ARGV>` in code only reads the channel whose elements are checked.
  for (const read of view.matchAll(/<\s*ARGV\s*>/g)) spans.push([read.index!, read.index! + read[0].length]);
  for (const mention of text.matchAll(/ARGV/g)) {
    const at = mention.index!;
    if (!spans.some(([start, end]) => at >= start && at < end)) return "ARGV used outside a literal @ARGV list assignment";
  }
  out.push(...paths);
  return null;
}

/** Shell-quote one word so re-tokenizing yields exactly `word`. */
const quoteWord = (word: string): string => `'${word.replace(/'/g, `'\\''`)}'`;

/** The inline programs a command's interpreters run (`-c`/`-e`, here-strings, heredocs). */
function inlinePrograms(command: string): { programs: Program[]; unresolved: string | null } {
  const programs: Program[] = [];
  const tree = inspectCommandSubstitutionTree(command);
  if (!tree.complete) return { programs, unresolved: "incomplete shell syntax" };
  for (const text of tree.commands) {
    for (const rawSegment of splitCommandSegments(text)) {
      let segment = stripShellControlPrefix(rawSegment);
      let head = effectiveHead(segment);
      if (head !== null && !EVAL_INTERPRETERS.has(interpreterFamily(head))) {
        // A wrapper (`timeout 5 python3 -c …`): judge the wrapped command.
        const tokens = tokenizeShellWords(segment, ARGV);
        const stripped = stripLeadingAssignmentsAndWrappers(tokens);
        const wrapped = stripped[0]?.replace(/^.*\//, "");
        if (stripped.length === tokens.length || wrapped === undefined || !EVAL_INTERPRETERS.has(interpreterFamily(wrapped))) continue;
        if (stripped.some((word) => /[$`]/.test(word))) return { programs, unresolved: `${wrapped} program behind a wrapper` };
        segment = stripped.map(quoteWord).join(" ");
        head = wrapped;
      }
      if (head === null) continue;
      const family = interpreterFamily(head);
      if (!EVAL_INTERPRETERS.has(family)) continue;
      const extracted = interpreterEvalPrograms(segment);
      if (extracted.kind === "violation") return { programs, unresolved: `${family} invocation (${extracted.reason})` };
      if (extracted.kind === "eval") {
        const language = interpreterLanguage(family);
        const texts = extracted.join ? [extracted.programs.join("\n")] : extracted.programs;
        for (const program of texts) programs.push({ language, text: program });
      }
    }
  }
  for (const { command: clause, literals } of commandStdin(command)) {
    const invocation = interpreterStdinProgram(clause);
    if (invocation.kind === "none" || literals.length === 0) continue;
    if (invocation.kind === "unvetted") return { programs, unresolved: `${invocation.head} stdin program` };
    for (const literal of literals) {
      if (literal.text === null) return { programs, unresolved: `${invocation.head} stdin program` };
      programs.push({ language: interpreterLanguage(invocation.head), text: literal.text });
    }
  }
  return { programs, unresolved: null };
}

/**
 * Every static path the command's inline interpreter programs open for
 * reading, or the first read whose target is not a static literal.
 */
export function inlineProgramReadPaths(command: string): InlineProgramReads {
  const paths: string[] = [];
  const { programs, unresolved } = inlinePrograms(command);
  if (unresolved !== null) return { paths, unresolved };
  for (const program of programs) {
    const why = programReads(program, paths);
    if (why !== null) return { paths, unresolved: why };
  }
  return { paths, unresolved: null };
}
