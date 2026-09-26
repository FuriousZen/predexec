/**
 * predexec toml-lite — a hand-rolled TOML reader for `~/.codex/config.toml`.
 * No TOML dependency is allowed, so the file Codex itself writes is read by
 * this parser instead.
 *
 * Coverage (Task 13, CX-1): the full TOML value grammar — basic / literal /
 * multi-line strings (`"""`, `'''`, every TOML escape incl. `\u`/`\U`),
 * integers (`1_000`, `0x`/`0o`/`0b`), floats (`1e5`, `inf`, `nan`), booleans,
 * datetimes (kept as their source text), nested arrays, inline tables,
 * `[table]` and `[[array.of.tables]]` headers, and dotted keys. Codex's own
 * UI writes `[[skills.config]]` (codex-rs/core/src/config/edit.rs:529) and
 * inline tables, so rejecting them locked every user out.
 *
 * Error policy — the reader only needs `projects` (trust) and
 * `project_root_markers` (project-root discovery), so:
 * - a parse error in a statement that touches either key (a header whose
 *   text names them, a key/value inside such a table, or a root key/value
 *   naming them) fails the whole read: `{ ok: false, error }`.
 * - a parse error anywhere else drops only that statement and is recorded as
 *   `warnings` (`line N: message`); after a bad header, the keys that follow
 *   are parsed but discarded rather than misfiled into the previous table.
 *   Recovery restarts on the line after the failing statement's first line,
 *   so a broken multi-line construct cannot swallow a later `[projects]`
 *   section unseen.
 * - a table header defined twice (`[a]` ... `[a]`) always fails: TOML forbids
 *   it and the old reader silently merged it (CX-7).
 * Pure function, no imports.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}
export type TomlParseResult =
  | { ok: true; value: Record<string, unknown>; warnings?: string[] }
  | { ok: false; error: string };

/** Root keys whose statements may not be dropped: a lost trust entry or marker list is a fail-open. */
const CRITICAL_TEXT_RE = /projects|project_root_markers/;
const CRITICAL_ROOT_KEYS = new Set(["projects", "project_root_markers"]);

class TomlError extends Error {
  constructor(
    public readonly pos: number,
    message: string,
    /** A hard error fails the read even outside `projects` (duplicate table headers). */
    public readonly hard = false,
  ) {
    super(message);
  }
}

const SIMPLE_ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\x1b",
  '"': '"',
  "\\": "\\",
};

const BARE_KEY_RE = /[A-Za-z0-9_-]/;
const DEC_INT_RE = /^[+-]?(?:0|[1-9](?:_?\d)*)$/;
const HEX_RE = /^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/;
const OCT_RE = /^0o[0-7](?:_?[0-7])*$/;
const BIN_RE = /^0b[01](?:_?[01])*$/;
const FLOAT_RE = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/;
const SPECIAL_FLOAT_RE = /^[+-]?(?:inf|nan)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;
const TIME_RE = /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

class Parser {
  i = 0;
  readonly root: TomlTable = {};
  /** Tables defined by a `[header]` — a second identical header is an error. */
  private readonly headerDefined = new WeakSet<TomlTable>();
  /** Tables created by dotted keys — a header may not reopen them. */
  private readonly dottedDefined = new WeakSet<TomlTable>();
  /** Inline tables are closed: nothing may extend them. */
  private readonly frozen = new WeakSet<TomlTable>();
  /** Arrays created by `[[header]]` (a static array cannot be appended to). */
  private readonly tableArrays = new WeakSet<TomlValue[]>();

  constructor(private readonly s: string) {}

  lineOf(pos: number): number {
    let line = 1;
    for (let k = 0; k < pos && k < this.s.length; k++) if (this.s[k] === "\n") line++;
    return line;
  }

  lineEnd(pos: number): number {
    const nl = this.s.indexOf("\n", pos);
    return nl === -1 ? this.s.length : nl;
  }

  skipWs(): void {
    while (this.s[this.i] === " " || this.s[this.i] === "\t") this.i++;
  }

  /** Whitespace, newlines and comments — between statements and inside arrays / inline tables. */
  skipWsNewlinesComments(): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else if (c === "#") this.i = this.lineEnd(this.i);
      else return;
    }
  }

  /** After a statement: optional whitespace and comment, then a newline or EOF. */
  expectStatementEnd(): void {
    this.skipWs();
    if (this.s[this.i] === "#") this.i = this.lineEnd(this.i);
    if (this.s[this.i] === "\r" && this.s[this.i + 1] === "\n") this.i++;
    if (this.i < this.s.length && this.s[this.i] !== "\n") throw new TomlError(this.i, "unexpected trailing content after value");
  }

  parseKey(): string[] {
    const keys: string[] = [];
    for (;;) {
      this.skipWs();
      const c = this.s[this.i];
      if (c === '"') keys.push(this.parseBasicString());
      else if (c === "'") keys.push(this.parseLiteralString());
      else {
        const start = this.i;
        while (this.i < this.s.length && BARE_KEY_RE.test(this.s[this.i]!)) this.i++;
        if (this.i === start) throw new TomlError(this.i, "invalid key");
        keys.push(this.s.slice(start, this.i));
      }
      this.skipWs();
      if (this.s[this.i] !== ".") return keys;
      this.i++;
    }
  }

  parseEscape(): string {
    const pos = this.i;
    const c = this.s[this.i + 1] ?? "";
    const simple = SIMPLE_ESCAPES[c];
    if (simple !== undefined) {
      this.i += 2;
      return simple;
    }
    const width = c === "u" ? 4 : c === "U" ? 8 : c === "x" ? 2 : 0;
    const hex = this.s.slice(this.i + 2, this.i + 2 + width);
    if (width === 0 || !new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex))
      throw new TomlError(pos, `invalid escape sequence "\\${c}"`);
    const code = parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new TomlError(pos, "escape is not a Unicode scalar value");
    this.i += 2 + width;
    return String.fromCodePoint(code);
  }

  parseBasicString(): string {
    const start = this.i;
    this.i++;
    let out = "";
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === "\n") break;
      if (c === '"') {
        this.i++;
        return out;
      }
      if (c === "\\") out += this.parseEscape();
      else (out += c), this.i++;
    }
    throw new TomlError(this.i < this.s.length ? this.i : start, "unterminated string");
  }

  parseLiteralString(): string {
    const start = this.i;
    const end = this.s.indexOf("'", this.i + 1);
    const nl = this.s.indexOf("\n", this.i + 1);
    if (end === -1 || (nl !== -1 && nl < end)) throw new TomlError(nl === -1 ? start : nl, "unterminated string");
    this.i = end + 1;
    return this.s.slice(start + 1, end);
  }

  /** `"""` / `'''` strings: first newline trimmed; up to two quotes may sit before the closing delimiter. */
  parseMultilineString(quote: '"' | "'"): string {
    const start = this.i;
    const delim = quote.repeat(3);
    this.i += 3;
    if (this.s[this.i] === "\n") this.i++;
    else if (this.s[this.i] === "\r" && this.s[this.i + 1] === "\n") this.i += 2;
    let out = "";
    while (this.i < this.s.length) {
      if (this.s.startsWith(delim, this.i)) {
        let run = 3;
        while (this.s[this.i + run] === quote) run++;
        if (run > 5) throw new TomlError(this.i, "too many quotes closing a multi-line string");
        out += quote.repeat(run - 3);
        this.i += run;
        return out;
      }
      const c = this.s[this.i]!;
      if (quote === '"' && c === "\\") {
        // Line-ending backslash: trim the newline and all whitespace after it.
        let j = this.i + 1;
        while (this.s[j] === " " || this.s[j] === "\t") j++;
        if (this.s[j] === "\n" || (this.s[j] === "\r" && this.s[j + 1] === "\n")) {
          while (j < this.s.length && /[ \t\r\n]/.test(this.s[j]!)) j++;
          this.i = j;
          continue;
        }
        out += this.parseEscape();
        continue;
      }
      out += c;
      this.i++;
    }
    throw new TomlError(start, "unterminated multi-line string");
  }

  parseBare(): TomlValue {
    const start = this.i;
    while (this.i < this.s.length && !/[\s,\]}#]/.test(this.s[this.i]!)) this.i++;
    let t = this.s.slice(start, this.i);
    // `1979-05-27 07:32:00` — a space-separated datetime.
    if (DATE_RE.test(t) && this.s[this.i] === " " && /^\d{2}:/.test(this.s.slice(this.i + 1, this.i + 4))) {
      this.i++;
      while (this.i < this.s.length && !/[\s,\]}#]/.test(this.s[this.i]!)) this.i++;
      t = this.s.slice(start, this.i);
    }
    if (t === "true") return true;
    if (t === "false") return false;
    const digits = t.replace(/_/g, "");
    if (DEC_INT_RE.test(t)) return parseInt(digits, 10);
    if (HEX_RE.test(t)) return parseInt(digits.slice(2), 16);
    if (OCT_RE.test(t)) return parseInt(digits.slice(2), 8);
    if (BIN_RE.test(t)) return parseInt(digits.slice(2), 2);
    if (SPECIAL_FLOAT_RE.test(t)) return t.endsWith("nan") ? NaN : t.startsWith("-") ? -Infinity : Infinity;
    if (FLOAT_RE.test(t)) return parseFloat(digits);
    if (DATETIME_RE.test(t) || TIME_RE.test(t)) return t;
    throw new TomlError(start, `unsupported value "${t}"`);
  }

  parseValue(): TomlValue {
    this.skipWs();
    const c = this.s[this.i];
    if (c === undefined || c === "\n" || c === "\r" || c === "#") throw new TomlError(this.i, "missing value");
    if (this.s.startsWith('"""', this.i)) return this.parseMultilineString('"');
    if (this.s.startsWith("'''", this.i)) return this.parseMultilineString("'");
    if (c === '"') return this.parseBasicString();
    if (c === "'") return this.parseLiteralString();
    if (c === "[") return this.parseArray();
    if (c === "{") return this.parseInlineTable();
    return this.parseBare();
  }

  parseArray(): TomlValue[] {
    const start = this.i;
    this.i++;
    const arr: TomlValue[] = [];
    for (;;) {
      this.skipWsNewlinesComments();
      if (this.i >= this.s.length) throw new TomlError(start, "unterminated array");
      if (this.s[this.i] === "]") {
        this.i++;
        return arr;
      }
      arr.push(this.parseValue());
      this.skipWsNewlinesComments();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] === "]") {
        this.i++;
        return arr;
      } else if (this.i >= this.s.length) throw new TomlError(start, "unterminated array");
      else throw new TomlError(this.i, 'expected "," or "]" in array');
    }
  }

  parseInlineTable(): TomlTable {
    const start = this.i;
    this.i++;
    const table: TomlTable = {};
    for (;;) {
      this.skipWsNewlinesComments();
      if (this.i >= this.s.length) throw new TomlError(start, "unterminated inline table");
      if (this.s[this.i] === "}") {
        this.i++;
        break;
      }
      const keyPos = this.i;
      const keys = this.parseKey();
      if (this.s[this.i] !== "=") throw new TomlError(this.i, 'expected "=" after key');
      this.i++;
      this.assign(table, keys, this.parseValue(), keyPos);
      this.skipWsNewlinesComments();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "}") throw new TomlError(this.i, 'expected "," or "}" in inline table');
    }
    this.frozen.add(table);
    return table;
  }

  isTable(v: TomlValue | undefined): v is TomlTable {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  /** `a.b.c = v` into `table`: intermediate tables are created as dotted-defined. */
  assign(table: TomlTable, keys: string[], value: TomlValue, pos: number): void {
    let node = table;
    for (const k of keys.slice(0, -1)) {
      const existing = node[k];
      if (existing === undefined) {
        const created: TomlTable = {};
        this.dottedDefined.add(created);
        node[k] = created;
        node = created;
      } else if (this.isTable(existing) && !this.frozen.has(existing) && !this.headerDefined.has(existing)) node = existing;
      else throw new TomlError(pos, `cannot extend "${k}" with a dotted key`);
    }
    const last = keys[keys.length - 1]!;
    if (Object.prototype.hasOwnProperty.call(node, last)) throw new TomlError(pos, `duplicate key "${last}"`);
    node[last] = value;
  }

  /** `[a.b]` / `[[a.b]]` — returns the table later key/values go into. */
  openHeader(keys: string[], isArray: boolean, pos: number): TomlTable {
    let node = this.root;
    for (const k of keys.slice(0, -1)) {
      const existing = node[k];
      if (existing === undefined) {
        const created: TomlTable = {};
        node[k] = created;
        node = created;
      } else if (Array.isArray(existing) && this.tableArrays.has(existing)) node = existing[existing.length - 1] as TomlTable;
      else if (this.isTable(existing) && !this.frozen.has(existing)) node = existing;
      else throw new TomlError(pos, `cannot redefine "${k}" as a table`);
    }
    const last = keys[keys.length - 1]!;
    const existing = node[last];
    const header = `[${isArray ? "[" : ""}${keys.join(".")}${isArray ? "]" : ""}]`;
    if (isArray) {
      const table: TomlTable = {};
      this.headerDefined.add(table);
      if (existing === undefined) {
        const arr: TomlValue[] = [table];
        this.tableArrays.add(arr);
        node[last] = arr;
      } else if (Array.isArray(existing) && this.tableArrays.has(existing)) existing.push(table);
      else throw new TomlError(pos, `cannot redefine "${last}" as an array of tables`);
      return table;
    }
    if (existing === undefined) {
      const table: TomlTable = {};
      this.headerDefined.add(table);
      node[last] = table;
      return table;
    }
    if (this.isTable(existing)) {
      if (this.headerDefined.has(existing)) throw new TomlError(pos, `table ${header} defined more than once`, true);
      if (this.frozen.has(existing) || this.dottedDefined.has(existing))
        throw new TomlError(pos, `cannot reopen "${last}" with a table header`);
      this.headerDefined.add(existing);
      return existing;
    }
    throw new TomlError(pos, `cannot redefine "${last}" as a table`);
  }
}

export function parseTomlLite(text: string): TomlParseResult {
  const p = new Parser(text);
  const warnings: string[] = [];
  let current: TomlTable = p.root;
  /** Root key of the current table, or null for the root table / a discarded table. */
  let currentRootKey: string | null = null;
  let discarding = false;

  for (;;) {
    p.skipWsNewlinesComments();
    if (p.i >= text.length) break;
    const stmtStart = p.i;
    const isHeader = text[stmtStart] === "[";
    try {
      if (isHeader) {
        const isArray = text[stmtStart + 1] === "[";
        p.i += isArray ? 2 : 1;
        const keys = p.parseKey();
        if (text[p.i] !== "]" || (isArray && text[p.i + 1] !== "]")) throw new TomlError(p.i, "malformed table header");
        p.i += isArray ? 2 : 1;
        p.expectStatementEnd();
        current = p.openHeader(keys, isArray, stmtStart);
        currentRootKey = keys[0]!;
        discarding = false;
      } else {
        const keys = p.parseKey();
        if (text[p.i] !== "=") throw new TomlError(p.i, 'expected "=" after key');
        p.i++;
        const value = p.parseValue();
        p.expectStatementEnd();
        p.assign(current, keys, value, stmtStart);
      }
    } catch (e) {
      if (!(e instanceof TomlError)) throw e;
      const message = `line ${p.lineOf(e.pos)}: ${e.message}`;
      const firstLine = text.slice(stmtStart, p.lineEnd(stmtStart));
      const critical =
        e.hard ||
        (isHeader
          ? CRITICAL_TEXT_RE.test(firstLine)
          : currentRootKey !== null
            ? CRITICAL_ROOT_KEYS.has(currentRootKey)
            : !discarding && CRITICAL_TEXT_RE.test(firstLine.split("=")[0]!));
      if (critical) return { ok: false, error: message };
      warnings.push(message);
      if (isHeader) {
        // Keys under a header we could not open must not land in the previous table.
        current = {};
        currentRootKey = null;
        discarding = true;
      }
      p.i = p.lineEnd(stmtStart);
    }
  }
  return warnings.length > 0 ? { ok: true, value: p.root, warnings } : { ok: true, value: p.root };
}
