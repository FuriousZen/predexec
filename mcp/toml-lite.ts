/**
 * predexec toml-lite — a deliberately SMALL, fail-closed TOML subset reader.
 * No TOML dependency is allowed, so `~/.codex/config.toml` (Task 4, Task 6) is
 * read by this hand-rolled parser instead: parse the subset confidently, or
 * return `{ ok: false, error }` naming the offending line — never a silent
 * wrong parse.
 *
 * Supported: `[table]` / `[table.sub."quoted key"]` headers (quote-aware dot
 * splitting); bare/quoted `key = value`; basic strings (`\"`/`\\`/`\n`/`\t`
 * escapes), literal strings (raw), booleans, integers, floats, and flat
 * arrays of those (may span lines). `#` comments are string-aware. Reopening
 * a table via a second identical/prefix-sharing header merges (matches
 * TOML); a duplicate key within a table is a hard failure.
 *
 * NOT supported (fails loudly, naming the line): inline tables `{...}`,
 * array-of-tables `[[x]]`, datetimes, nested arrays, dotted keys on the LEFT
 * of `=`, string concatenation, multi-line strings — every field the Codex
 * adapters read is representable without them, so e.g.
 * `approval_policy = { granular = {...} }` fails the read and the caller
 * falls closed. Pure function, no imports.
 */

export type TomlValue = string | number | boolean | TomlValue[];
export type TomlTable = { [key: string]: TomlTable | TomlValue };
export type TomlParseResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/** Threads the offending line number out of the recursive descent so the
 * top-level catch can format `line N: <message>` without passing it through
 * every helper. */
class TomlLineError extends Error {
  constructor(
    public readonly lineNo: number,
    message: string,
  ) {
    super(message);
  }
}

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", n: "\n", t: "\t" };

/** Index of the first `target` char outside a string, or -1 — shared by
 * comment-stripping (target `#`) and key/value splitting (target `=`). */
function firstUnquotedIndex(line: string, target: string): number {
  let q: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (q === '"' && c === "\\") i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === target) return i;
  }
  return -1;
}

/** Strip a `#` comment, string-aware (a `#` inside a quoted value survives). */
function stripComment(line: string): string {
  const idx = firstUnquotedIndex(line, "#");
  return idx === -1 ? line : line.slice(0, idx);
}

function parseBasicString(s: string, pos: number): { value: string; pos: number } {
  let i = pos + 1,
    out = "";
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\n") break;
    if (c === '"') return { value: out, pos: i + 1 };
    if (c === "\\") {
      const esc = ESCAPES[s[i + 1] ?? ""];
      if (esc === undefined) throw new Error(`unsupported escape sequence "\\${s[i + 1] ?? ""}"`);
      (out += esc), i++;
    } else out += c;
  }
  throw new Error("unterminated string");
}

function parseLiteralString(s: string, pos: number): { value: string; pos: number } {
  const end = s.indexOf("'", pos + 1);
  if (end === -1 || s.slice(pos, end).includes("\n")) throw new Error("unterminated string");
  return { value: s.slice(pos + 1, end), pos: end + 1 };
}

/** A single bare or quoted key token, fully consuming `text`. */
function parseKeyToken(text: string): string {
  if (text[0] === '"' || text[0] === "'") {
    const r = text[0] === '"' ? parseBasicString(text, 0) : parseLiteralString(text, 0);
    if (r.pos !== text.length) throw new Error(`invalid key "${text}"`);
    return r.value;
  }
  if (/^[A-Za-z0-9_-]+$/.test(text)) return text;
  throw new Error(`invalid key "${text}"`);
}

/** Split a table header's inner text on unquoted `.`, into validated key tokens. */
function splitDottedKey(s: string): string[] {
  const parts: string[] = [];
  let cur = "",
    q: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      cur += c;
      if (q === '"' && c === "\\") (cur += s[i + 1] ?? ""), i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") (q = c), (cur += c);
    else if (c === ".") (parts.push(cur.trim()), (cur = ""));
    else cur += c;
  }
  parts.push(cur.trim());
  return parts.map(parseKeyToken);
}

/** Bracket-depth balance, string-aware — decides whether an array value needs
 * more lines. Structural validity is enforced by parseArray below. */
function arrayIsClosed(text: string): boolean {
  let depth = 0,
    q: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (q === '"' && c === "\\") i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
  }
  return depth <= 0;
}

function parseBareValue(s: string, pos: number): { value: TomlValue; pos: number } {
  let i = pos;
  while (i < s.length && !/[\s,\]]/.test(s[i]!)) i++;
  const t = s.slice(pos, i);
  if (t === "true" || t === "false") return { value: t === "true", pos: i };
  if (/^[+-]?\d+$/.test(t)) return { value: parseInt(t, 10), pos: i };
  if (/^[+-]?\d+\.\d+([eE][+-]?\d+)?$/.test(t)) return { value: parseFloat(t), pos: i };
  throw new Error(`unsupported value "${t}"`);
}

function parseValue(s: string, pos: number, insideArray: boolean): { value: TomlValue; pos: number } {
  while (pos < s.length && /\s/.test(s[pos]!)) pos++;
  if (pos >= s.length) throw new Error("missing value");
  const c = s[pos]!;
  if (c === '"') return parseBasicString(s, pos);
  if (c === "'") return parseLiteralString(s, pos);
  if (c === "{") throw new Error("inline tables are not supported");
  if (c === "[") {
    if (insideArray) throw new Error("nested arrays are not supported");
    return parseArray(s, pos);
  }
  return parseBareValue(s, pos);
}

function parseArray(s: string, pos: number): { value: TomlValue[]; pos: number } {
  let i = pos + 1;
  const arr: TomlValue[] = [];
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) throw new Error("unterminated array");
    if (s[i] === "]") return { value: arr, pos: i + 1 };
    const r = parseValue(s, i, true);
    arr.push(r.value);
    i = r.pos;
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s[i] === ",") i++;
    else if (s[i] === "]") return { value: arr, pos: i + 1 };
    else throw new Error('expected "," or "]" in array');
  }
}

/** Parse one full value; rejects trailing content (catches string concatenation). */
function parseFullValue(text: string): TomlValue {
  const r = parseValue(text, 0, false);
  if (text.slice(r.pos).trim() !== "") throw new Error("unexpected trailing content after value");
  return r.value;
}

export function parseTomlLite(text: string): TomlParseResult {
  try {
    const lines = text.split(/\r\n|\n/).map(stripComment);
    const root: TomlTable = {};
    let current: TomlTable = root;
    let i = 0;
    while (i < lines.length) {
      const lineNo = i + 1;
      const line = lines[i]!.trim();
      i++;
      if (line === "") continue;

      try {
        if (line[0] === "[") {
          if (line[1] === "[") throw new Error('array-of-tables ("[[...]]") are not supported');
          if (!line.endsWith("]")) throw new Error("malformed table header");
          let node = root;
          for (const seg of splitDottedKey(line.slice(1, -1))) {
            const existing = node[seg];
            if (existing === undefined) node[seg] = {};
            else if (typeof existing !== "object" || Array.isArray(existing))
              throw new Error(`cannot redefine "${seg}" as a table`);
            node = node[seg] as TomlTable;
          }
          current = node;
          continue;
        }

        const eq = firstUnquotedIndex(line, "=");
        if (eq === -1) throw new Error("expected key = value");
        const keyText = line.slice(0, eq).trim();
        if (keyText[0] !== '"' && keyText[0] !== "'" && keyText.includes("."))
          throw new Error("dotted keys are not supported (use a [table.sub] header instead)");
        const key = parseKeyToken(keyText);

        let valueText = line.slice(eq + 1).trim();
        while (valueText[0] === "[" && !arrayIsClosed(valueText)) {
          if (i >= lines.length) throw new Error("unterminated array");
          (valueText += "\n" + lines[i]), i++;
        }
        const value = parseFullValue(valueText);
        if (Object.prototype.hasOwnProperty.call(current, key)) throw new Error(`duplicate key "${key}"`);
        current[key] = value;
      } catch (e) {
        throw new TomlLineError(lineNo, (e as Error).message);
      }
    }
    return { ok: true, value: root };
  } catch (e) {
    if (e instanceof TomlLineError) return { ok: false, error: `line ${e.lineNo}: ${e.message}` };
    throw e;
  }
}
