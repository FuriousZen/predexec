/**
 * Interpreter program scanning for the destructive-command heuristic
 * (core/destructive.ts). Given an inline program (`node -e`, `python -c`, ...),
 * builds its executable view (strings and comments masked, bounded by the
 * LANGUAGE_* budgets), finds command-execution and fs-writer calls per
 * language, decodes static open modes, and recurses into shell bodies the
 * program spawns (backticks, `qx`, `%x`) through the injected classifier.
 */


/**
 * fs-writer API tokens inside interpreter eval payloads. Heuristic: names the
 * common Node fs / Python os/shutil/pathlib writers; an obfuscated writer
 * (`require("fs")["write"+"FileSync"]`) will get through — this narrows the
 * gap, it does not close it.
 */
export const EVAL_WRITER_RE =
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
export const MAX_LANGUAGE_ARGUMENT_LENGTH = 64 * 1024;
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

export interface LanguageViewDetails {
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

export type InterpolationLanguage = "node" | "python" | "ruby" | "perl" | "php";

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
export function executableLanguageView(
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

export interface LanguageScanState {
  depth: number;
  shellBodies: Set<ShellBody>;
  shellBodyCount: number;
  /**
   * The shell classifier, applied to each interpreter-spawned shell body.
   * Injected by core/destructive.ts so this module need not import it back.
   */
  classifyShell: (command: string, depth: number) => string | null;
}

export function scanLanguagePayload(
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
  const shellMutation = state.classifyShell(shell.body, state.depth + 1);
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
export function captureLanguageCall(source: string, openIndex: number, options: LanguageSyntaxOptions): string | null {
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
export function splitTopLevelArguments(args: string, options: LanguageSyntaxOptions): string[] | null {
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
export function decodeStaticMode(arg: string, language: ModeLanguage): StaticMode {
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

/** Capture bare Perl arguments, continuing across newline comments only while incomplete. */
export function captureBarePerlArguments(
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
