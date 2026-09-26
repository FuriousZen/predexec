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

/** gray-matter's split: a leading `---` line, the YAML, a closing `---` line. */
export function parseFrontmatter(content: string): Frontmatter {
  const text = content.replace(/^﻿/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text) ?? /^---[ \t]*\r?\n()---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const yaml = m[1] ?? "";
  const data = yaml.trim() === "" ? {} : parseYamlSubset(yaml);
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("frontmatter is not a mapping");
  return { data: data as Json, body: text.slice(m[0].length) };
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
    if (raw.includes("\t") && /^\s*\t/.test(raw)) throw new Error("tab indentation");
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

  const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#{}[\],&*!|>%@`-][^:#]*?|-[^\s:#][^:#]*?)\s*:(?:\s+(.*))?$/;

  function parseKey(k: string): string {
    return k.startsWith('"') || k.startsWith("'") ? unquote(k).value : k.trim();
  }

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
      const m = KEY.exec(l.text);
      if (!m) throw new Error(`not a mapping entry: ${l.text}`);
      pos++;
      const key = parseKey(m[1]!);
      if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`duplicate key: ${key}`);
      out[key] = valueAfter(m[2], indent, indent === 0);
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
      if (KEY.test(item.trim()) && !item.trim().startsWith("{") && !item.trim().startsWith("[")) {
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
