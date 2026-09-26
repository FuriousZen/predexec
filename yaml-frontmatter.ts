/**
 * Minimal YAML-frontmatter reader for opencode v2 agent/mode markdown files
 * (harness-facing, used by policy.ts). opencode parses these with gray-matter
 * (js-yaml), retrying top-level plain values that contain `: ` as block
 * scalars (v2.0.16 core `config/markdown.ts:3-38`). This covers the subset
 * agent files use: block mappings and sequences, flow `{}`/`[]`, quoted and
 * plain scalars, `|`/`>` block scalars, comments. Anything outside it (anchors,
 * aliases, tags, multi-line flow, ...) THROWS: the caller then fails closed
 * for that agent rather than guess at its permissions.
 */

type Json = Record<string, unknown>;

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
  if (!text.startsWith("---")) return { data: {}, body: text };
  if (text.length > MAX_FRONTMATTER_FILE_BYTES) throw new Error("agent file too large");
  const lines = text.split("\n");
  const bare = (i: number) => (lines[i] ?? "").replace(/\r$/, "");
  if (bare(0) !== "---") throw new Error("frontmatter opening line must be exactly ---");
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (!bare(i).startsWith("---")) continue;
    if (bare(i) !== "---") throw new Error("frontmatter closing line must be exactly ---");
    close = i;
    break;
  }
  if (close < 0) throw new Error("unclosed frontmatter");
  const yaml = lines.slice(1, close).map((_, i) => bare(i + 1)).join("\n");
  const data = yaml.trim() === "" ? {} : parseYamlSubset(yaml);
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("frontmatter is not a mapping");
  return { data: data as Json, body: lines.slice(close + 1).join("\n") };
}

/**
 * Linear split of a block-mapping line into key and the text after `:` —
 * no regex over the unbounded line. `null` when the line is not a
 * `key: value` entry. Throws on the YAML merge key `<<`, which js-yaml
 * resolves and this reader does not.
 */
function splitKey(t: string): { key: string; rest: string } | null {
  let key: string;
  let after: string;
  if (t.startsWith('"') || t.startsWith("'")) {
    const { value, rest } = unquote(t);
    let i = 0;
    while (i < rest.length && (rest[i] === " " || rest[i] === "\t")) i++;
    if (rest[i] !== ":") return null;
    after = rest.slice(i + 1);
    if (after !== "" && after[0] !== " " && after[0] !== "\t") return null;
    key = value;
  } else {
    if (t === "" || "\"'#{}[],&*!|>%@`?".includes(t[0]!)) return null;
    if (t[0] === "-" && (t.length === 1 || t[1] === " " || t[1] === "\t")) return null;
    let i = 0;
    for (; i < t.length; i++) {
      const c = t[i]!;
      if (c === "#" && (t[i - 1] === " " || t[i - 1] === "\t")) return null;
      if (c === ":" && (i + 1 === t.length || t[i + 1] === " " || t[i + 1] === "\t")) break;
    }
    if (i === t.length) return null;
    key = t.slice(0, i).trimEnd();
    after = t.slice(i + 1);
    if (key === "") return null;
  }
  if (key === "<<") throw new Error("YAML merge keys are not supported");
  return { key, rest: after };
}

interface Line {
  indent: number;
  text: string;
}

const scalar = (raw: string): unknown => {
  const v = raw.trim();
  if (v === "" || v === "~" || v === "null" || v === "Null" || v === "NULL") return null;
  if (/^(true|True|TRUE)$/.test(v)) return true;
  if (/^(false|False|FALSE)$/.test(v)) return false;
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(v)) return Number(v);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(v)) return Number(v);
  if (/^[&*!%@`|>]/.test(v)) throw new Error(`unsupported YAML construct: ${v}`);
  return v;
};

/** Strip a trailing ` # comment` from a plain value (quotes are handled before this). */
const stripComment = (v: string): string => {
  const i = v.search(/\s#/);
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
function inlineValue(raw: string, topLevel: boolean): unknown {
  const v = raw.trim();
  if (v.startsWith('"') || v.startsWith("'")) {
    const { value, rest } = unquote(v);
    if (stripComment(rest).trim() !== "") throw new Error("unexpected text after quoted string");
    return value;
  }
  if (v.startsWith("{") || v.startsWith("[")) {
    const p = new FlowParser(stripComment(v));
    const out = p.value();
    p.end();
    return out;
  }
  const plain = stripComment(v).trim();
  if (/^[&*!%@`]/.test(plain)) throw new Error(`unsupported YAML construct: ${plain}`);
  // js-yaml rejects `a: b: c`; gray-matter then re-reads a TOP-LEVEL value as
  // a literal block scalar (config/markdown.ts:22-37). Nested ones stay errors.
  if (/:\s/.test(plain) || plain.endsWith(":")) {
    if (topLevel) return plain;
    throw new Error(`mapping value not allowed here: ${plain}`);
  }
  return scalar(plain);
}

class FlowParser {
  private i = 0;
  constructor(private readonly s: string) {}
  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }
  end(): void {
    this.ws();
    if (this.i !== this.s.length) throw new Error("unexpected text after flow collection");
  }
  value(): unknown {
    this.ws();
    const c = this.s[this.i];
    if (c === "{") return this.map();
    if (c === "[") return this.seq();
    if (c === '"' || c === "'") {
      const { value, rest } = unquote(this.s.slice(this.i));
      this.i = this.s.length - rest.length;
      return value;
    }
    const start = this.i;
    while (this.i < this.s.length && !",}]".includes(this.s[this.i]!)) {
      if (this.s[this.i] === ":" && /\s/.test(this.s[this.i + 1] ?? " ")) break;
      this.i++;
    }
    return scalar(this.s.slice(start, this.i));
  }
  private map(): Json {
    this.i++;
    const out: Json = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === "}") {
        this.i++;
        return out;
      }
      const key = this.value();
      if (key === "<<") throw new Error("YAML merge keys are not supported");
      this.ws();
      if (this.s[this.i] !== ":") throw new Error("expected ':' in flow mapping");
      this.i++;
      out[String(key)] = this.value();
      this.ws();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "}") throw new Error("expected ',' or '}' in flow mapping");
    }
  }
  private seq(): unknown[] {
    this.i++;
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === "]") {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.ws();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "]") throw new Error("expected ',' or ']' in flow sequence");
    }
  }
}

/** Parses the frontmatter YAML subset. Throws on anything unsupported. */
export function parseYamlSubset(yaml: string): unknown {
  const lines: Line[] = [];
  for (const raw of yaml.split(/\r?\n/)) {
    if (raw.length > MAX_FRONTMATTER_LINE_CHARS) throw new Error("frontmatter line too long");
    if (/^ *\t/.test(raw)) throw new Error("tab indentation");
    const text = raw.trimEnd();
    if (text.trim() === "" || text.trim().startsWith("#")) {
      lines.push({ indent: -1, text: "" }); // kept for block scalars
      continue;
    }
    if (/^(---|\.\.\.)\s*$/.test(text)) throw new Error("multiple YAML documents");
    lines.push({ indent: text.length - text.trimStart().length, text: text.trimStart() });
  }
  let pos = 0;
  const skipBlank = () => {
    while (pos < lines.length && lines[pos]!.indent < 0) pos++;
  };

  function blockScalar(indicator: string, parentIndent: number): string {
    const keep = indicator.endsWith("+");
    const strip = indicator.endsWith("-");
    const folded = indicator.startsWith(">");
    const collected: string[] = [];
    let indent = -1;
    while (pos < lines.length) {
      const l = lines[pos]!;
      if (l.indent < 0) {
        collected.push("");
        pos++;
        continue;
      }
      if (l.indent <= parentIndent) break;
      if (indent < 0) indent = l.indent;
      if (l.indent < indent) break;
      collected.push(" ".repeat(l.indent - indent) + l.text);
      pos++;
    }
    while (!keep && collected.length && collected[collected.length - 1] === "") collected.pop();
    const text = folded ? collected.join(" ") : collected.join("\n");
    return strip ? text : text + "\n";
  }

  function valueAfter(rest: string | undefined, parentIndent: number, topLevel: boolean): unknown {
    const v = (rest ?? "").trim();
    if (v === "" || v.startsWith("#")) {
      skipBlank();
      const next = lines[pos];
      if (!next) return null;
      if (next.indent > parentIndent) return node(next.indent);
      // A block sequence may sit at its parent key's own indentation.
      if (next.indent === parentIndent && (next.text.startsWith("- ") || next.text === "-")) return sequence(parentIndent);
      return null;
    }
    if (/^[|>][-+]?$/.test(v)) return blockScalar(v, parentIndent);
    return inlineValue(v, topLevel);
  }

  function mapping(indent: number): Json {
    const out: Json = {};
    for (;;) {
      skipBlank();
      const l = lines[pos];
      if (!l || l.indent < indent) return out;
      if (l.indent > indent) throw new Error(`unexpected indentation: ${l.text}`);
      if (l.text.startsWith("- ") || l.text === "-") return out; // sibling sequence belongs to the parent
      const m = splitKey(l.text);
      if (!m) throw new Error("not a mapping entry");
      pos++;
      if (Object.prototype.hasOwnProperty.call(out, m.key)) throw new Error(`duplicate key: ${m.key}`);
      out[m.key] = valueAfter(m.rest, indent, indent === 0);
    }
  }

  function sequence(indent: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      skipBlank();
      const l = lines[pos];
      if (!l || l.indent !== indent || !(l.text.startsWith("- ") || l.text === "-")) return out;
      const item = l.text === "-" ? "" : l.text.slice(2);
      const itemIndent = indent + 2 + (item.length - item.trimStart().length);
      if (item.trim() === "") {
        pos++;
        out.push(valueAfter("", indent + 1, false));
        continue;
      }
      if (splitKey(item.trim()) !== null) {
        // `- key: value` starts a mapping whose later keys sit at itemIndent.
        lines[pos] = { indent: itemIndent, text: item.trim() };
        out.push(mapping(itemIndent));
        continue;
      }
      pos++;
      out.push(inlineValue(item, false));
    }
  }

  function node(indent: number): unknown {
    skipBlank();
    const l = lines[pos];
    if (!l) return null;
    return l.text.startsWith("- ") || l.text === "-" ? sequence(indent) : mapping(indent);
  }

  skipBlank();
  const first = lines[pos];
  if (!first) return {};
  if (first.indent !== 0) throw new Error("frontmatter must start at column 0");
  const result = node(0);
  skipBlank();
  if (pos < lines.length) throw new Error(`unparsed frontmatter line: ${lines[pos]!.text}`);
  return result;
}
