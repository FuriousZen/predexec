/**
 * Minimal YAML-frontmatter reader for opencode v2 agent/mode markdown files
 * (harness-facing, used by policy.ts). opencode parses these with gray-matter
 * (js-yaml 3), and when that throws it rewrites EVERY top-level plain value
 * containing `:` into a block scalar and retries (v2.0.16 core
 * `config/markdown.ts:3-38`).
 *
 * R45 — this reads only an unambiguous core of YAML, one where js-yaml's first
 * parse is certain to succeed with the same result (so the sanitize retry never
 * runs): block mappings and sequences, single-line flow `{}`/`[]`, quoted and
 * plain scalars, `|`/`>` block scalars, comments. Anything else THROWS, and the
 * caller fails closed (deny-all) for that agent rather than guess:
 * - keys other than `^[A-Za-z_][A-Za-z0-9_-]*$` outside the `permission` map;
 *   inside it (R46), plain keys may also carry spaces and glob characters
 *   (`git *: allow`) within js-yaml's plain-key rules (see
 *   `checkPermissionPlainKey`), and quoted keys are allowed without escapes;
 *   `__proto__`/`constructor`/`prototype`, `<<`, and duplicate keys at any
 *   level, block or flow;
 * - control characters (tab and lone CR included), non-ASCII whitespace, line
 *   separators, lone surrogates;
 * - plain scalars that start with a YAML indicator, contain `: `/` #`, or that
 *   js-yaml would type as anything but a string (null, YAML 1.1 bools, every
 *   int/float/timestamp form) — except the canonical `true`/`false`, decimal
 *   ints and `d.d` floats, returned typed for the caller's schema checks;
 * - (R46) a top-level plain value is held to the same `: `/` #` rule as any
 *   other: a bare `:` as in `openrouter/x:free` or `https://x.y` is plain
 *   content to js-yaml, whose first parse then succeeds, so v2's sanitize
 *   retry (which rewrites top-level values containing `:`) never runs;
 * - anchors, aliases, tags, merge keys, multi-document and multi-line flow.
 * Every mapping is built with `Object.create(null)`. The first failure is
 * thrown as a `FrontmatterError` carrying the 1-based line (in the whole file
 * for `parseFrontmatter`, in the YAML text for `parseYamlSubset`) and reason.
 */

type Json = Record<string, unknown>;

/** Why and where a document fell outside the core — `predexec doctor` prints both. */
export class FrontmatterError extends Error {
  readonly line: number;
  readonly reason: string;
  constructor(line: number, reason: string) {
    super(`line ${line}: ${reason}`);
    this.name = "FrontmatterError";
    this.line = line;
    this.reason = reason;
  }
}

export interface Frontmatter {
  data: Json;
  body: string;
}

/** Hard caps: past these the caller treats the file as unreadable (fail closed), never as partial. */
export const MAX_FRONTMATTER_FILE_BYTES = 256 * 1024;
export const MAX_FRONTMATTER_LINE_CHARS = 4096;

/**
 * Strict split — certainty or throw (R44). A file that does not start with
 * `---` has no frontmatter (as in gray-matter 4.0.3). One that does must be
 * exactly: an opening line `---`, YAML, a closing line `---`. gray-matter also
 * accepts shapes this refuses — a language tag (`---yaml`, `---json`), a
 * closing line that merely STARTS with `---` (`----`, `---x`), an unclosed
 * block read to EOF — so each of those throws instead of guessing.
 */
export function parseFrontmatter(content: string): Frontmatter {
  const text = content.replace(/^﻿/, "");
  if (!text.startsWith("---")) return { data: Object.create(null), body: text };
  if (text.length > MAX_FRONTMATTER_FILE_BYTES) throw new FrontmatterError(1, "agent file too large");
  const lines = text.split("\n");
  const bare = (i: number) => (lines[i] ?? "").replace(/\r$/, "");
  if (bare(0) !== "---") throw new FrontmatterError(1, "frontmatter opening line must be exactly ---");
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (!bare(i).startsWith("---")) continue;
    if (bare(i) !== "---") throw new FrontmatterError(i + 1, "frontmatter closing line must be exactly ---");
    close = i;
    break;
  }
  if (close < 0) throw new FrontmatterError(1, "unclosed frontmatter");
  const yaml = lines.slice(1, close).map((_, i) => bare(i + 1)).join("\n");
  let data: unknown;
  try {
    data = yaml.trim() === "" ? Object.create(null) : parseYamlSubset(yaml);
  } catch (err) {
    // The YAML starts on the file's line 2.
    if (err instanceof FrontmatterError) throw new FrontmatterError(err.line + 1, err.reason);
    throw err;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new FrontmatterError(2, "frontmatter is not a mapping");
  return { data: data as Json, body: lines.slice(close + 1).join("\n") };
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** Every character a YAML indicator may start a plain scalar with. */
const INDICATORS = "-?:,[]{}#&*!|>'\"%@`";
/**
 * Characters outside the core: C0/C1 controls (tab and CR included — a CRLF's
 * CR is stripped before this runs), DEL, js-yaml's non-printables, U+0085 and
 * the Unicode line/paragraph separators, non-ASCII whitespace (which `trim()`
 * would eat but js-yaml keeps), BOM, and lone surrogates.
 */
const FORBIDDEN_CHAR =
  /[\x00-\x09\x0B-\x1F\x7F-\x9F\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Superset of js-yaml 3's implicit null/bool/int/float/timestamp resolvers (plus YAML 1.1 bools). */
const NON_STRING = [
  /^(~|null|Null|NULL)$/,
  /^(true|false|yes|no|on|off|y|n)$/i,
  /^[-+]?[._]*[0-9][0-9A-Za-z_.:+-]*$/,
  /^[-+]?\.(inf|nan)$/i,
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}/,
];

/** Plain key: identifier-shaped (or, in the permission map, glob-shaped), not reserved, not something js-yaml types. */
function checkPlainKey(key: string, inPermission: boolean, flow: boolean): string {
  if (inPermission) return checkPermissionPlainKey(key, flow);
  if (!KEY_RE.test(key) || NON_STRING.some((re) => re.test(key))) throw new Error(`unsupported mapping key: ${key}`);
  if (RESERVED_KEYS.has(key)) throw new Error(`reserved mapping key: ${key}`);
  return key;
}

/**
 * R46 — a plain key inside the `permission` map may hold spaces and glob
 * characters (`git *`, `rm -rf *`, `src/**`), within js-yaml 3's plain-scalar
 * rules (loader `readPlainScalar`): the first character is no indicator, the
 * key ends at the first `: ` (the caller's split), it has no ` #` (a comment),
 * and no surrounding whitespace (js-yaml trims it; this refuses rather than
 * trims). In a flow mapping the flow indicators `,[]{}` end a plain scalar,
 * so they are refused there. `#`, `:` and quote characters are refused
 * anywhere in the key — legal in js-yaml mid-scalar, but not needed for a
 * command glob and each one is a place a reader can disagree.
 */
const PERMISSION_KEY_FORBIDDEN = /[#:'"\\]/;
function checkPermissionPlainKey(key: string, flow: boolean): string {
  if (key === "" || key !== key.trim()) throw new Error(`unsupported mapping key: ${key}`);
  if (INDICATORS.includes(key[0]!)) throw new Error(`mapping key starts with a YAML indicator: ${key}`);
  if (PERMISSION_KEY_FORBIDDEN.test(key) || (flow && /[,[\]{}]/.test(key))) throw new Error(`unsupported character in mapping key: ${key}`);
  if (key.startsWith("<<")) throw new Error(`merge key: ${key}`);
  if (NON_STRING.some((re) => re.test(key))) throw new Error(`mapping key js-yaml would not read as a string: ${key}`);
  if (RESERVED_KEYS.has(key)) throw new Error(`reserved mapping key: ${key}`);
  return key;
}

/** Quoted key: only inside the permission map, never with an escape sequence. */
function checkQuotedKey(key: string, escaped: boolean, inPermission: boolean): string {
  if (!inPermission) throw new Error(`quoted key outside the permission map: ${key}`);
  if (escaped) throw new Error("escape sequence in a quoted key");
  if (RESERVED_KEYS.has(key)) throw new Error(`reserved mapping key: ${key}`);
  return key;
}

/** Reads a quoted token at the start of `t`; `escaped` when it used `\` or `''`. */
function quoted(t: string): { value: string; rest: string; escaped: boolean } {
  const { value, rest } = unquote(t);
  const inner = t.slice(1, t.length - rest.length - 1);
  return { value, rest, escaped: t[0] === '"' ? inner.includes("\\") : inner.includes("''") };
}

/**
 * A plain (unquoted) scalar token, already trimmed of comments. Returns the
 * canonical `true`/`false`/decimal int/`d.d` float typed; any other form js-yaml
 * would not read as the same string throws.
 */
function plainScalar(v: string): unknown {
  if (v === "") throw new Error("empty plain scalar");
  if (v !== v.trim()) throw new Error("plain scalar with surrounding whitespace");
  if (INDICATORS.includes(v[0]!)) throw new Error(`plain scalar starts with a YAML indicator: ${v}`);
  // js-yaml throws on `a: b: c`, and v2 then rewrites EVERY top-level value
  // containing `:` (config/markdown.ts:22-37). A `:` NOT followed by a space
  // (`openrouter/x:free`, `https://x.y`) is plain-scalar content to js-yaml,
  // whose first parse then succeeds, so the retry never runs (R46).
  if (/: |:$| #/.test(v)) throw new Error(`mapping value not allowed here (quote it): ${v}`);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(v)) return Number(v);
  if (NON_STRING.some((re) => re.test(v))) throw new Error(`plain scalar js-yaml would not read as a string: ${v}`);
  return v;
}

/**
 * Linear split of a block-mapping line into key and the text after `:` —
 * no regex over the unbounded line. `null` when the line is not a
 * `key: value` entry; a line that is one but whose key is outside the core
 * throws (via the key checks).
 */
function splitKey(t: string, inPermission: boolean): { key: string; rest: string } | null {
  if (t.startsWith('"') || t.startsWith("'")) {
    const { value, rest, escaped } = quoted(t);
    if (!(rest === ":" || rest.startsWith(": "))) return null;
    return { key: checkQuotedKey(value, escaped, inPermission), rest: rest.slice(1) };
  }
  if (t === "" || INDICATORS.includes(t[0]!)) return null;
  let i = 0;
  for (; i < t.length; i++) {
    const c = t[i]!;
    if (c === "#" && t[i - 1] === " ") return null;
    if (c === ":" && (i + 1 === t.length || t[i + 1] === " ")) break;
  }
  if (i === t.length) return null;
  return { key: checkPlainKey(t.slice(0, i), inPermission, false), rest: t.slice(i + 1) };
}

interface Line {
  indent: number;
  text: string;
  /** Blank (`""`) or comment-only line; `raw` keeps it verbatim for block scalars. */
  skip: boolean;
  raw: string;
}

/** Strip a trailing ` # comment` from a plain value (quotes are handled before this). */
const stripComment = (v: string): string => {
  const i = v.indexOf(" #");
  return i >= 0 ? v.slice(0, i) : v;
};

function unquote(v: string): { value: string; rest: string } {
  const q = v[0];
  if (q === "'") {
    let out = "";
    let i = 1;
    for (; i < v.length; i++) {
      if (v[i] === "'") {
        if (v[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        return { value: out, rest: v.slice(i + 1) };
      }
      out += v[i];
    }
    throw new Error("unterminated single-quoted string");
  }
  let out = "";
  for (let i = 1; i < v.length; i++) {
    const c = v[i];
    if (c === "\\") {
      const n = v[++i];
      const map: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/", r: "\r", "0": "\0" };
      if (n === undefined || map[n] === undefined) throw new Error("unsupported escape in double-quoted string");
      out += map[n];
      continue;
    }
    if (c === '"') return { value: out, rest: v.slice(i + 1) };
    out += c;
  }
  throw new Error("unterminated double-quoted string");
}

/** A complete single-line value: quoted, flow, or plain. */
function inlineValue(raw: string, topLevel: boolean, inPermission: boolean): unknown {
  const v = raw.trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    const { value, rest } = unquote(v);
    if (stripComment(rest).trim() !== "") throw new Error("unexpected text after quoted string");
    return value;
  }
  if (v.startsWith("{") || v.startsWith("[")) {
    const p = new FlowParser(stripComment(v), inPermission);
    const out = p.value();
    p.end();
    return out;
  }
  return plainScalar(stripComment(v).trim());
}

/** Single-line flow collections. Whitespace is the ASCII space only (tabs never get here). */
class FlowParser {
  private i = 0;
  private readonly s: string;
  private readonly inPermission: boolean;
  constructor(s: string, inPermission: boolean) {
    this.s = s;
    this.inPermission = inPermission;
  }
  private ws(): void {
    while (this.s[this.i] === " ") this.i++;
  }
  end(): void {
    this.ws();
    if (this.i !== this.s.length) throw new Error("unexpected text after flow collection");
  }
  value(inPermission = this.inPermission): unknown {
    this.ws();
    const c = this.s[this.i];
    if (c === "{") return this.map(inPermission);
    if (c === "[") return this.seq(inPermission);
    if (c === '"' || c === "'") {
      const { value, rest } = unquote(this.s.slice(this.i));
      this.i = this.s.length - rest.length;
      return value;
    }
    const start = this.i;
    while (this.i < this.s.length && !",}]".includes(this.s[this.i]!)) {
      if (":#{[".includes(this.s[this.i]!)) throw new Error("unsupported character in a flow plain scalar");
      this.i++;
    }
    return plainScalar(this.s.slice(start, this.i).trimEnd());
  }
  private key(inPermission: boolean): string {
    this.ws();
    const c = this.s[this.i];
    if (c === '"' || c === "'") {
      const { value, rest, escaped } = quoted(this.s.slice(this.i));
      this.i = this.s.length - rest.length;
      return checkQuotedKey(value, escaped, inPermission);
    }
    const start = this.i;
    while (this.i < this.s.length && !":,}]".includes(this.s[this.i]!)) this.i++;
    return checkPlainKey(this.s.slice(start, this.i), inPermission, true);
  }
  private map(inPermission: boolean): Json {
    this.i++;
    const out: Json = Object.create(null);
    for (;;) {
      this.ws();
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      const key = this.key(inPermission);
      if (Object.hasOwn(out, key)) throw new Error(`duplicate key: ${key}`);
      if (this.s[this.i] !== ":" || this.s[this.i + 1] !== " ") throw new Error("expected ': ' in flow mapping");
      this.i++;
      out[key] = this.value(inPermission);
      this.ws();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "}") throw new Error("expected ',' or '}' in flow mapping");
    }
  }
  private seq(inPermission: boolean): unknown[] {
    this.i++;
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      out.push(this.value(inPermission));
      this.ws();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "]") throw new Error("expected ',' or ']' in flow sequence");
    }
  }
}

/** Parses the frontmatter YAML subset. Throws a `FrontmatterError` on anything outside it. */
export function parseYamlSubset(yaml: string): unknown {
  // Index of the line being read when a check throws; rethrown with it below.
  const where = { at: 0 };
  try {
    return parseYamlLines(yaml, where);
  } catch (err) {
    if (err instanceof FrontmatterError) throw err;
    throw new FrontmatterError(where.at + 1, err instanceof Error ? err.message : String(err));
  }
}

function parseYamlLines(yaml: string, where: { at: number }): unknown {
  const lines: Line[] = [];
  for (const raw of yaml.split(/\r?\n/)) {
    where.at = lines.length;
    if (raw.length > MAX_FRONTMATTER_LINE_CHARS) throw new Error("frontmatter line too long");
    if (FORBIDDEN_CHAR.test(raw)) throw new Error("control character, lone CR or non-ASCII whitespace in frontmatter");
    const text = raw.trimEnd();
    if (text.trim() === "" || text.trim().startsWith("#")) {
      lines.push({ indent: -1, text: "", skip: true, raw });
      continue;
    }
    if (/^(---|\.\.\.)( |$)/.test(text)) throw new Error("multiple YAML documents");
    lines.push({ indent: text.length - text.trimStart().length, text: text.trimStart(), skip: false, raw });
  }
  let pos = 0;
  const skipBlank = () => {
    while (pos < lines.length && lines[pos]!.skip) pos++;
  };

  /**
   * `|`/`>` block scalars. Refuses what js-yaml would read differently from
   * this simple reader: comment-looking or whitespace-carrying blank lines,
   * trailing whitespace, more-indented lines in a folded scalar, keep chomping.
   */
  function blockScalar(indicator: string, parentIndent: number): string {
    // Keep chomping (`+`) depends on trailing lines the frontmatter split cuts: doubt.
    if (indicator.endsWith("+")) throw new Error("keep-chomping block scalars are not supported");
    const strip = indicator.endsWith("-");
    const folded = indicator.startsWith(">");
    const collected: string[] = [];
    let indent = -1;
    while (pos < lines.length) {
      where.at = pos;
      const l = lines[pos]!;
      if (l.skip) {
        if (l.raw !== "") {
          // A comment-looking line is content in js-yaml, a comment here: doubt.
          const ind = l.raw.length - l.raw.trimStart().length;
          if (l.raw.trim() === "" || ind > parentIndent) throw new Error("ambiguous line inside a block scalar");
          break;
        }
        collected.push("");
        pos++;
        continue;
      }
      if (l.indent <= parentIndent) break;
      if (indent < 0) indent = l.indent;
      if (l.indent < indent) break;
      if (l.raw !== l.raw.trimEnd()) throw new Error("trailing whitespace inside a block scalar");
      if (folded && l.indent !== indent) throw new Error("more-indented line in a folded block scalar");
      collected.push(" ".repeat(l.indent - indent) + l.text);
      pos++;
    }
    while (collected.length && collected[collected.length - 1] === "") collected.pop();
    let text: string;
    if (folded) {
      text = "";
      let empties = 0;
      let started = false;
      for (const line of collected) {
        if (line === "") {
          empties++;
          continue;
        }
        text += started ? (empties > 0 ? "\n".repeat(empties) : " ") : "\n".repeat(empties);
        text += line;
        started = true;
        empties = 0;
      }
    } else text = collected.join("\n");
    if (collected.length === 0) throw new Error("empty block scalar");
    return strip ? text : text + "\n";
  }

  function valueAfter(rest: string | undefined, parentIndent: number, topLevel: boolean, inPermission: boolean): unknown {
    const v = (rest ?? "").trim();
    if (v === "" || v.startsWith("#")) {
      skipBlank();
      const next = lines[pos];
      if (!next) return null;
      if (next.indent > parentIndent) return node(next.indent, inPermission);
      // A block sequence may sit at its parent key's own indentation.
      if (next.indent === parentIndent && (next.text.startsWith("- ") || next.text === "-")) return sequence(parentIndent, inPermission);
      return null;
    }
    if (/^[|>][-+]?$/.test(v)) return blockScalar(v, parentIndent);
    return inlineValue(v, topLevel, inPermission);
  }

  function mapping(indent: number, inPermission: boolean): Json {
    const out: Json = Object.create(null);
    for (;;) {
      skipBlank();
      const l = lines[pos];
      if (!l || l.indent < indent) return out;
      where.at = pos;
      if (l.indent > indent) throw new Error(`unexpected indentation: ${l.text}`);
      if (l.text.startsWith("- ") || l.text === "-") return out; // sibling sequence belongs to the parent
      const m = splitKey(l.text, inPermission);
      if (!m) throw new Error("not a mapping entry");
      pos++;
      if (Object.hasOwn(out, m.key)) throw new Error(`duplicate key: ${m.key}`);
      const topLevel = indent === 0 && !inPermission;
      out[m.key] = valueAfter(m.rest, indent, topLevel, inPermission || (topLevel && m.key === "permission"));
    }
  }

  function sequence(indent: number, inPermission: boolean): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      skipBlank();
      const l = lines[pos];
      if (!l || l.indent !== indent || !(l.text.startsWith("- ") || l.text === "-")) return out;
      where.at = pos;
      const item = l.text === "-" ? "" : l.text.slice(2);
      const itemIndent = indent + 2 + (item.length - item.trimStart().length);
      if (item.trim() === "") {
        pos++;
        out.push(valueAfter("", indent + 1, false, inPermission));
        continue;
      }
      if (splitKey(item.trim(), inPermission) !== null) {
        // `- key: value` starts a mapping whose later keys sit at itemIndent.
        lines[pos] = { ...l, indent: itemIndent, text: item.trim() };
        out.push(mapping(itemIndent, inPermission));
        continue;
      }
      pos++;
      out.push(inlineValue(item, false, inPermission));
    }
  }

  function node(indent: number, inPermission: boolean): unknown {
    skipBlank();
    const l = lines[pos];
    if (!l) return null;
    return l.text.startsWith("- ") || l.text === "-" ? sequence(indent, inPermission) : mapping(indent, inPermission);
  }

  skipBlank();
  const first = lines[pos];
  if (!first) {
    // Comments only. gray-matter 4.0.3 (index.js:101-110) returns `{}` without
    // parsing only when removing `^\s*#[^\n]+` lines leaves nothing; a bare `#`
    // line survives that, so js-yaml parses the block and yields `null` data.
    const bare = lines.findIndex((l) => l.raw.trimStart() === "#");
    if (bare >= 0) {
      where.at = bare;
      throw new Error("comment-only frontmatter with a bare '#' line (gray-matter reads it as null)");
    }
    return Object.create(null);
  }
  where.at = pos;
  if (first.indent !== 0) throw new Error("frontmatter must start at column 0");
  const result = node(0, false);
  skipBlank();
  where.at = pos;
  if (pos < lines.length) throw new Error(`unparsed frontmatter line: ${lines[pos]!.text}`);
  return result;
}
