/**
 * predexec core — deterministic condition-DSL evaluator.
 *
 * evaluateCondition is total and exception-safe: a malformed condition (bad
 * regex, unparseable JSON, missing file) evaluates to `false`, never throwing.
 * A thrown exception mid-walk would be a silent false-hit hazard; returning
 * false instead degrades to a benign miss (no edge matches => fallback).
 *
 * Totality also has to cover NON-termination, which a try/catch cannot: regexes
 * here are model-authored and run against up to OUTPUT_CAP characters, so a
 * catastrophically-backtracking pattern hangs the whole walk rather than
 * throwing. Measured on this code: `(a+)+$` against 32 a's took 32s, doubling
 * per added character. isSafeRegex screens those out — see below.
 */

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createContext, Script, type Context } from "node:vm";
import {
  MAX_CONDITION_LENGTH,
  MAX_CONDITION_TOTAL_LENGTH,
  MAX_JSON_VALUE_DEPTH,
  MAX_JSON_VALUE_NODES,
  MAX_JSON_VALUE_STRING_LENGTH,
  MAX_NODE_ID_LENGTH,
  type Condition,
  type NodeOutput,
} from "./types.ts";

const EXIT_RE = /^exit\s*(==|!=|>|<)\s*(\d+)$/;
// Greedy `(.+)` with the `$` anchor takes everything between the first and last
// `/`, which is what a regex containing a literal slash needs.
const MATCH_RE = /^(stdout|stderr)\s*(=~|!~)\s*\/(.+)\/$/;
const FILE_RE = /^file\s+(exists|missing)\s+(.+)$/;

/**
 * Reject regexes prone to catastrophic backtracking.
 *
 * The screen is intentionally conservative: it rejects a repeated group whose
 * body can split one input across iterations in more than one way — `(a+)+`,
 * `([a-z]+)+`, `(\w+\s*)+`, `(aa?)+` — and a quantified alternation whose
 * branches can consume the same prefix, such as `(a|aa)+` and `(a|a?)+`.
 * Lookarounds and `\b`/`\B` are zero-width and never count as separators. A
 * body whose variable part is followed by a disjoint fixed atom is still
 * allowed, so ordinary matchers like `(?:\d+\.)+\d+` remain usable.
 *
 * The screen is not complete (ungrouped `a*a*a*a*b` is polynomial and passes),
 * so every execution also runs under REGEX_EVAL_TIMEOUT_MS.
 */
const SYNTHETIC_TRUNCATION_MARKER_RE = /…\[truncated(?:: \d+ more chars)?\]/g;

interface JsonValueInspection {
  nodes: number;
  stringLength: number;
  error: string | null;
}

type JsonValueFrame = { value: unknown; depth: number; exit?: false } | { value: object; exit: true };

/**
 * Inspect a direct jsonPath comparison value without recursion. JSON parsed
 * from stdout is already bounded by the output cap, but model callers can
 * pass arbitrary objects (including cycles) through the public API.
 */
function inspectJsonValue(value: unknown): JsonValueInspection {
  const active = new WeakSet<object>();
  const stack: JsonValueFrame[] = [{ value, depth: 0 }];
  let nodes = 0;
  let stringLength = 0;

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.exit) {
      active.delete(frame.value);
      continue;
    }

    nodes += 1;
    if (nodes > MAX_JSON_VALUE_NODES) {
      return { nodes, stringLength, error: `jsonPath comparison value exceeds the maximum of ${MAX_JSON_VALUE_NODES} nodes` };
    }
    if (frame.depth > MAX_JSON_VALUE_DEPTH) {
      return {
        nodes,
        stringLength,
        error: `jsonPath comparison value exceeds the maximum nesting depth of ${MAX_JSON_VALUE_DEPTH}`,
      };
    }
    const current = frame.value;
    if (typeof current === "string") {
      if (current.length > MAX_JSON_VALUE_STRING_LENGTH) {
        return {
          nodes,
          stringLength,
          error: `jsonPath comparison string exceeds the maximum length of ${MAX_JSON_VALUE_STRING_LENGTH} characters`,
        };
      }
      stringLength += current.length;
      if (stringLength > MAX_CONDITION_TOTAL_LENGTH) {
        return {
          nodes,
          stringLength,
          error: `jsonPath comparison strings exceed the aggregate maximum of ${MAX_CONDITION_TOTAL_LENGTH} characters`,
        };
      }
      continue;
    }
    if (current === null || typeof current === "boolean" || typeof current === "number") {
      if (typeof current === "number" && !Number.isFinite(current)) {
        return { nodes, stringLength, error: "jsonPath comparison value contains a non-finite number" };
      }
      continue;
    }
    if (typeof current !== "object") {
      return { nodes, stringLength, error: `jsonPath comparison value contains unsupported ${typeof current}` };
    }
    if (active.has(current)) {
      return { nodes, stringLength, error: "jsonPath comparison value contains a cyclic reference" };
    }
    active.add(current);
    stack.push({ value: current, exit: true });
    if (Array.isArray(current)) {
      if (current.length > MAX_JSON_VALUE_NODES - nodes) {
        return { nodes, stringLength, error: `jsonPath comparison value exceeds the maximum of ${MAX_JSON_VALUE_NODES} nodes` };
      }
      for (let index = current.length - 1; index >= 0; index--) {
        stack.push({ value: current[index], depth: frame.depth + 1 });
      }
      continue;
    }
    let keys: string[];
    try {
      keys = Object.keys(current);
    } catch {
      return { nodes, stringLength, error: "jsonPath comparison value could not be inspected" };
    }
    if (keys.length > MAX_JSON_VALUE_NODES - nodes) {
      return { nodes, stringLength, error: `jsonPath comparison value exceeds the maximum of ${MAX_JSON_VALUE_NODES} nodes` };
    }
    const record = current as Record<string, unknown>;
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]!;
      if (key.length > MAX_JSON_VALUE_STRING_LENGTH) {
        return {
          nodes,
          stringLength,
          error: `jsonPath comparison string exceeds the maximum length of ${MAX_JSON_VALUE_STRING_LENGTH} characters`,
        };
      }
      stringLength += key.length;
      if (stringLength > MAX_CONDITION_TOTAL_LENGTH) {
        return {
          nodes,
          stringLength,
          error: `jsonPath comparison strings exceed the aggregate maximum of ${MAX_CONDITION_TOTAL_LENGTH} characters`,
        };
      }
      try {
        stack.push({ value: record[key], depth: frame.depth + 1 });
      } catch {
        return { nodes, stringLength, error: "jsonPath comparison value could not be inspected" };
      }
    }
  }
  return { nodes, stringLength, error: null };
}

/** Check edge-authored strings before any parser, compiler, or evaluator sees them. */
export function conditionStringBudget(
  when: unknown,
  edgeTo: unknown,
  currentTotal = 0,
): { total: number; error: string | null } {
  const parts: Array<{ label: string; value: string; limit: number }> = [];
  let total = currentTotal;
  if (typeof when === "string") {
    parts.push({ label: "condition string", value: when, limit: MAX_CONDITION_LENGTH });
  } else if (when && typeof when === "object") {
    const condition = when as Record<string, unknown>;
    for (const [key, value] of Object.entries(when)) {
      if (key === "value" && condition.kind === "jsonPath" && (condition.op === "eq" || condition.op === "ne")) {
        const inspection = inspectJsonValue(value);
        if (inspection.error) return { total, error: inspection.error };
        total += inspection.stringLength;
        if (total > MAX_CONDITION_TOTAL_LENGTH) {
          return {
            total,
            error: `condition payload aggregate exceeds the maximum length of ${MAX_CONDITION_TOTAL_LENGTH} characters`,
          };
        }
      } else if (typeof value === "string") {
        parts.push({ label: `condition ${key}`, value, limit: MAX_CONDITION_LENGTH });
      }
    }
  }
  if (typeof edgeTo === "string") parts.push({ label: "edge target", value: edgeTo, limit: MAX_NODE_ID_LENGTH });

  for (const part of parts) {
    if (part.value.length > part.limit) {
      return { total, error: `${part.label} exceeds the maximum length of ${part.limit} characters` };
    }
    total += part.value.length;
    if (total > MAX_CONDITION_TOTAL_LENGTH) {
      return {
        total,
        error: `condition payload aggregate exceeds the maximum length of ${MAX_CONDITION_TOTAL_LENGTH} characters`,
      };
    }
  }
  return { total, error: null };
}

type RegexCharSet = Set<string> | "any" | "unknown";

interface RegexAtom {
  first: RegexCharSet;
  optional: boolean;
  quantifiedOpenEnded: boolean;
  /** Characters the open-ended part can keep consuming ("unknown" when not tracked). */
  openSet: RegexCharSet;
}

interface RegexSequence {
  atoms: RegexAtom[];
  nullable: boolean;
  first: RegexCharSet;
  endsOpenEnded: boolean;
  /** openSet of the atom that makes the sequence end open-ended. */
  tail: RegexCharSet;
}

const ASCII_DIGITS = new Set("0123456789");
const ASCII_WORD = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz");
const ASCII_SPACE = new Set("\t\n\r \f\v");

function unionCharSets(a: RegexCharSet, b: RegexCharSet): RegexCharSet {
  if (a === "any" || b === "any") return "any";
  if (a === "unknown" || b === "unknown") return "unknown";
  return new Set([...a, ...b]);
}

function charSetsOverlap(a: RegexCharSet, b: RegexCharSet): boolean {
  if (a === "any" || b === "any" || a === "unknown" || b === "unknown") return true;
  for (const ch of a) if (b.has(ch)) return true;
  return false;
}

function matchingParen(pattern: string, open: number): number {
  let depth = 0;
  let inClass = false;
  for (let i = open; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (!inClass && ch === "(") depth += 1;
    else if (!inClass && ch === ")" && --depth === 0) return i;
  }
  return -1;
}

function splitAlternatives(body: string): string[] {
  const alternatives: string[] = [];
  let start = 0;
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (!inClass && ch === "(") depth += 1;
    else if (!inClass && ch === ")") depth = Math.max(0, depth - 1);
    else if (!inClass && depth === 0 && ch === "|") {
      alternatives.push(body.slice(start, i));
      start = i + 1;
    }
  }
  alternatives.push(body.slice(start));
  return alternatives;
}

const CONTROL_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v" };

/**
 * Characters an escape `\<ch>` can match. Escapes that do not denote their own
 * letter (`\x61`, `\u0061`, `\cA`, backreferences `\1` / `\k<n>`, and any other
 * letter or digit) are "unknown": treating `\x61` as the letter `x` would
 * manufacture a disjoint "separator" out of what is really an `a`.
 */
function escapeSet(ch: string): RegexCharSet {
  if (ch === "d") return ASCII_DIGITS;
  if (ch === "D") return "any";
  if (ch === "w") return ASCII_WORD;
  if (ch === "W") return "any";
  if (ch === "s") return ASCII_SPACE;
  if (ch === "S" || ch === "p" || ch === "P") return "any";
  if (CONTROL_ESCAPES[ch] !== undefined) return new Set(CONTROL_ESCAPES[ch]);
  if (/^[A-Za-z0-9]$/.test(ch)) return "unknown";
  return new Set(ch);
}

/** Read one escape starting at the backslash `source[i]`, consuming its full length. */
function readEscape(source: string, i: number): { set: RegexCharSet; next: number; zeroWidth: boolean } {
  const ch = source[i + 1] ?? "";
  let next = i + 2;
  if (ch === "b" || ch === "B") return { set: new Set(), next, zeroWidth: true };
  const skipTo = (close: string): void => {
    const end = source.indexOf(close, next);
    if (end >= 0) next = end + 1;
  };
  if ((ch === "p" || ch === "P" || ch === "u") && source[next] === "{") skipTo("}");
  else if (ch === "k" && source[next] === "<") skipTo(">");
  else if (ch === "x" && /^[0-9A-Fa-f]{2}/.test(source.slice(next))) next += 2;
  else if (ch === "u" && /^[0-9A-Fa-f]{4}/.test(source.slice(next))) next += 4;
  else if (ch === "c" && /^[A-Za-z]/.test(source[next] ?? "")) next += 1;
  else if (/^[0-9]$/.test(ch)) while (/^[0-9]$/.test(source[next] ?? "")) next += 1;
  return { set: escapeSet(ch), next, zeroWidth: false };
}

/** Group prefix (`?:`, `?<name>`, `?=`, `?!`, `?<=`, `?<!`, `?i:`) and whether it is a lookaround. */
function groupPrefix(inner: string): { length: number; lookaround: boolean } {
  const look = /^\?(?:[=!]|<[=!])/.exec(inner);
  if (look) return { length: look[0].length, lookaround: true };
  const other = /^\?(?:<[A-Za-z_$][\w$]*>|[imsx-]*:)/.exec(inner);
  return { length: other?.[0].length ?? 0, lookaround: false };
}

function classSet(body: string): RegexCharSet {
  if (body.startsWith("^") || body.includes("\\p{") || body.includes("\\P{")) return "any";
  const chars = new Set<string>();
  for (let i = 0; i < body.length; i++) {
    let current: RegexCharSet;
    if (body[i] === "\\") current = escapeSet(body[++i] ?? "");
    else current = new Set(body[i]);
    if (current === "any" || current === "unknown") return current;
    if (body[i + 1] === "-" && i + 2 < body.length && current.size === 1) {
      const from = [...current][0]!;
      const to = body[i + 2]!;
      for (let code = from.charCodeAt(0); code <= to.charCodeAt(0); code++) chars.add(String.fromCharCode(code));
      i += 2;
      continue;
    }
    for (const ch of current) chars.add(ch);
  }
  return chars;
}

interface RegexQuantifier {
  next: number;
  optional: boolean;
  /** Variable-length repetition: `+`, `*`, `{n,}`, or `{n,m}` with m > n and m >= 2. */
  openEnded: boolean;
  /** Can match its atom two or more times: openEnded, or an exact `{n}` with n >= 2. */
  repeats: boolean;
}

function readQuantifier(source: string, start: number): RegexQuantifier {
  const none = { next: start, optional: false, openEnded: false, repeats: false };
  const ch = source[start];
  let q: RegexQuantifier;
  if (ch === "+" || ch === "*") q = { next: start + 1, optional: ch === "*", openEnded: true, repeats: true };
  else if (ch === "?") q = { next: start + 1, optional: true, openEnded: false, repeats: false };
  else if (ch === "{") {
    const match = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(start));
    if (!match) return none;
    const min = Number.parseInt(match[1]!, 10);
    const max = match[2] === undefined ? min : match[3] === "" ? Infinity : Number.parseInt(match[3]!, 10);
    const openEnded = max > min && max >= 2;
    q = { next: start + match[0].length, optional: min === 0, openEnded, repeats: openEnded || max >= 2 };
  } else return none;
  // Lazy modifier (`+?`, `{2,}?`) does not change what can match.
  if (source[q.next] === "?") q.next += 1;
  return q;
}

function parseSequence(source: string): RegexSequence {
  const atoms: RegexAtom[] = [];
  let nullable = true;
  let first: RegexCharSet = new Set();
  let firstCanContinue = true;
  for (let i = 0; i < source.length;) {
    const ch = source[i]!;
    if (ch === "|") break;
    if (ch === "^" || ch === "$") {
      i += 1;
      continue;
    }
    let atomFirst: RegexCharSet;
    let nestedNullable = false;
    let nestedEndsOpenEnded = false;
    let nestedTail: RegexCharSet = "unknown";
    let isGroup = false;
    if (ch === "\\") {
      const escape = readEscape(source, i);
      if (escape.zeroWidth) {
        // `\b` / `\B` consume nothing, so they can neither separate nor start anything.
        i = readQuantifier(source, escape.next).next;
        continue;
      }
      atomFirst = escape.set;
      i = escape.next;
    } else if (ch === "[") {
      let end = i + 1;
      while (end < source.length) {
        if (source[end] === "\\") end += 2;
        else if (source[end] === "]") break;
        else end += 1;
      }
      atomFirst = end < source.length ? classSet(source.slice(i + 1, end)) : "unknown";
      i = end < source.length ? end + 1 : source.length;
    } else if (ch === "(") {
      const end = matchingParen(source, i);
      if (end < 0) {
        atomFirst = "unknown";
        i = source.length;
      } else {
        const prefix = groupPrefix(source.slice(i + 1, end));
        if (prefix.lookaround) {
          // Lookarounds are zero-width: transparent to the sequence.
          i = readQuantifier(source, end + 1).next;
          continue;
        }
        const nested = parseAlternativesSequence(source.slice(i + 1 + prefix.length, end));
        atomFirst = nested.first;
        nestedNullable = nested.nullable;
        nestedEndsOpenEnded = nested.endsOpenEnded;
        nestedTail = nested.tail;
        isGroup = true;
        i = end + 1;
      }
    } else {
      atomFirst = ch === "." ? "any" : new Set(ch);
      i += 1;
    }
    const quantifier = readQuantifier(source, i);
    i = quantifier.next;
    const optional = quantifier.optional || nestedNullable;
    // A quantified group can keep consuming any character in its body, which is
    // not tracked, so its open set is "unknown" (overlaps everything).
    const openSet: RegexCharSet = !quantifier.openEnded ? nestedTail : isGroup ? "unknown" : atomFirst;
    atoms.push({ first: atomFirst, optional, quantifiedOpenEnded: quantifier.openEnded || nestedEndsOpenEnded, openSet });
    if (firstCanContinue) {
      first = unionCharSets(first, atomFirst);
      firstCanContinue = optional;
    }
    if (!optional) nullable = false;
  }
  const last = atoms.at(-1);
  return {
    atoms,
    nullable,
    first,
    endsOpenEnded: last?.quantifiedOpenEnded ?? false,
    tail: last?.quantifiedOpenEnded ? last.openSet : new Set(),
  };
}

function parseAlternativesSequence(body: string): RegexSequence {
  const alternatives = splitAlternatives(body);
  let first: RegexCharSet = new Set();
  let nullable = false;
  let endsOpenEnded = false;
  let tail: RegexCharSet = new Set();
  for (const alternative of alternatives) {
    const shape = parseSequence(alternative);
    first = unionCharSets(first, shape.first);
    nullable ||= shape.nullable;
    endsOpenEnded ||= shape.endsOpenEnded;
    tail = unionCharSets(tail, shape.tail);
  }
  return { atoms: [], nullable, first, endsOpenEnded, tail };
}

function ambiguousAlternation(body: string): boolean {
  const alternatives = splitAlternatives(body);
  if (alternatives.length < 2) return false;
  const shapes = alternatives.map((alternative) => parseSequence(alternative));
  if (shapes.some((shape) => shape.nullable)) return true;
  for (let left = 0; left < shapes.length; left++) {
    for (let right = left + 1; right < shapes.length; right++) {
      const a = shapes[left]!.atoms;
      const b = shapes[right]!.atoms;
      const common = Math.min(a.length, b.length);
      let sharedPrefix = true;
      for (let i = 0; i < common; i++) {
        if (!charSetsOverlap(a[i]!.first, b[i]!.first)) {
          sharedPrefix = false;
          break;
        }
      }
      if (sharedPrefix && common > 0) return true;
    }
  }
  return false;
}

/**
 * Can one input be split across the repetitions of a repeated group body in
 * more than one way? That holds when an open-ended atom (`x+`, `x*`, `x{n,}`,
 * or a nested group whose body ends open-ended) is followed — through optional
 * atoms and fixed atoms over overlapping characters — by either another
 * optional/open-ended atom over overlapping characters (`x+x+`, `x+x?`), or by
 * the end of the body with the next repetition able to start on a character
 * the open-ended atom could also have consumed (`(a+)+`, `(\w+\s?)+`).
 *
 * A disjoint fixed atom separates cleanly: `(?:\d+\.)+` and `(\.\d+){2}` have
 * exactly one split, so they stay accepted.
 */
function ambiguousRepetition(body: string): boolean {
  const shapes = splitAlternatives(body).map((alternative) => parseSequence(alternative));
  let bodyFirst: RegexCharSet = new Set();
  for (const shape of shapes) bodyFirst = unionCharSets(bodyFirst, shape.first);
  // Can the characters `variable` might or might not take at atoms[i] instead be
  // taken by what follows, in more than one way?
  const ambiguousAfter = (atoms: RegexAtom[], i: number, variable: RegexCharSet): boolean => {
    for (let j = i + 1; j < atoms.length; j++) {
      const next = atoms[j]!;
      // Only the next atom's first character is adjacent to the variable part.
      if (charSetsOverlap(variable, next.first)) {
        if (next.optional || next.quantifiedOpenEnded) return true;
      } else if (!next.optional) {
        return false; // a disjoint fixed atom separates cleanly
      }
    }
    return charSetsOverlap(variable, bodyFirst);
  };
  for (const { atoms } of shapes) {
    for (let i = 0; i < atoms.length; i++) {
      const atom = atoms[i]!;
      if (atom.quantifiedOpenEnded && ambiguousAfter(atoms, i, atom.openSet)) return true;
      // Bounded optional atoms too: `(aa?)+` / `(a?a)+` split "aa" as one or two iterations.
      if (atom.optional && ambiguousAfter(atoms, i, atom.first)) return true;
    }
  }
  return false;
}

export function isSafeRegex(pattern: string): boolean {
  if (pattern.length > MAX_CONDITION_LENGTH) return false;
  let backslashParity = 0;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      backslashParity ^= 1;
      continue;
    }
    const escaped = backslashParity === 1;
    backslashParity = 0;
    if (pattern[i] !== "(" || escaped) continue;
    const end = matchingParen(pattern, i);
    if (end < 0) continue;
    if (!readQuantifier(pattern, end + 1).repeats) continue;
    const inner = pattern.slice(i + 1, end);
    const body = inner.slice(groupPrefix(inner).length);
    if (ambiguousRepetition(body) || ambiguousAlternation(body)) return false;
  }
  return true;
}

/** Escape a string for literal use inside a RegExp. */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const EXIT_OP: Record<string, "eq" | "ne" | "gt" | "lt"> = {
  "==": "eq", "!=": "ne", ">": "gt", "<": "lt",
};

export function parseConditionString(s: string): Condition | null {
  if (s.length > MAX_CONDITION_LENGTH) return null;
  const trimmed = s.trim();
  if (trimmed === "always") return { kind: "always" };

  let m = EXIT_RE.exec(trimmed);
  if (m) return { kind: "exitCode", op: EXIT_OP[m[1]!]!, value: Number(m[2]) };

  m = MATCH_RE.exec(trimmed);
  if (m) {
    return {
      kind: "match",
      source: m[1] as "stdout" | "stderr",
      regex: m[3]!,
      ...(m[2] === "!~" && { negate: true }),
    };
  }

  m = FILE_RE.exec(trimmed);
  if (m) {
    return {
      kind: "fileExists",
      path: m[2]!.trim(),
      ...(m[1] === "missing" && { negate: true }),
    };
  }

  return null;
}

/** One evaluation with a model-readable account of what was observed. */
export interface ConditionEvaluation {
  result: boolean;
  /** e.g. `exit == 0 → false (exit was 1)` — condition, verdict, observed value. */
  detail: string;
}

const OP_SYM: Record<string, string> = { eq: "==", ne: "!=", lt: "<", le: "<=", gt: ">", ge: ">=" };

/** Bounded JSON render for detail strings; never throws. */
function showValue(v: unknown): string {
  const inspection = inspectJsonValue(v);
  if (inspection.error) return `[${inspection.error}]`;
  if (v === null) return "null";
  if (typeof v === "string") return quoteJsonString(v).slice(0, 80) + (v.length > 80 ? "…" : "");
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    type RenderFrame = { text: string } | { value: unknown };
    const stack: RenderFrame[] = [{ value: v }];
    let text = "";
    while (stack.length > 0 && text.length < 80) {
      const frame = stack.pop()!;
      if ("text" in frame) {
        text += frame.text;
        continue;
      }
      if (frame.value === null) {
        text += "null";
      } else if (typeof frame.value === "string") {
        text += quoteJsonString(frame.value);
      } else if (typeof frame.value === "number" || typeof frame.value === "boolean") {
        text += String(frame.value);
      } else if (Array.isArray(frame.value)) {
        text += "[";
        stack.push({ text: "]" });
        for (let i = frame.value.length - 1; i >= 0; i--) {
          if (i < frame.value.length - 1) stack.push({ text: "," });
          stack.push({ value: frame.value[i] });
        }
      } else {
        const record = frame.value as Record<string, unknown>;
        const keys = Object.keys(record);
        text += "{";
        stack.push({ text: "}" });
        for (let i = keys.length - 1; i >= 0; i--) {
          const key = keys[i]!;
          if (i < keys.length - 1) stack.push({ text: "," });
          stack.push({ value: record[key] });
          stack.push({ text: `${quoteJsonString(key)}:` });
        }
      }
    }
    return text.length > 80 || stack.length > 0 ? `${text.slice(0, 80)}…` : text;
  } catch {
    return "[jsonPath comparison value could not be rendered]";
  }
}

function quoteJsonString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

/**
 * Wall-clock budget for one regex execution. isSafeRegex is a screen, not a
 * proof: an ungrouped polynomial pattern such as `a*a*a*a*b` passes it yet runs
 * for hours on OUTPUT_CAP characters. A try/catch cannot interrupt a running
 * regex, but V8's vm timeout can (measured: `a*a*a*a*b` on 8192 chars and
 * `(a+)+$` on 41 chars both stop at ~250ms).
 */
export const REGEX_EVAL_TIMEOUT_MS = 250;

let regexSandbox: { context: Context; exec: Script } | undefined;

/** `regex.exec(input)` under REGEX_EVAL_TIMEOUT_MS; `timedOut` instead of hanging. */
function execWithDeadline(regex: RegExp, input: string): { timedOut: false; match: RegExpExecArray | null } | { timedOut: true } {
  regexSandbox ??= { context: createContext({}), exec: new Script("regex.exec(input)") };
  const { context, exec } = regexSandbox;
  context.regex = regex;
  context.input = input;
  try {
    return { timedOut: false, match: exec.runInContext(context, { timeout: REGEX_EVAL_TIMEOUT_MS }) as RegExpExecArray | null };
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return { timedOut: true };
    throw error;
  } finally {
    context.regex = undefined;
    context.input = undefined;
  }
}

const TIMED_OUT_DETAIL = `regex exceeded its ${REGEX_EVAL_TIMEOUT_MS}ms time budget`;

/**
 * True when `target` is `root` or lies beneath it. Both paths must already be
 * absolute and normalized; this is the one containment rule the engine uses
 * for plan `cwd` and for condition paths.
 */
export function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * Canonical path for containment checks: the realpath of the deepest existing
 * ancestor (so a symlink inside the root that points outside it is caught, and
 * a root reached through a symlink such as macOS /tmp still compares equal),
 * with any not-yet-existing remainder appended lexically.
 */
function canonicalPath(path: string): string {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Evaluate + explain in one pass. The `detail` string is what the engine echoes
 * into the transcript when NO edge matches, so the model can fix its condition
 * instead of guessing — a silent false is how authoring errors turn into
 * misdiagnoses. Total and exception-safe like evaluateCondition.
 */
export function evaluateConditionWithDetail(
  output: NodeOutput,
  cond: Condition,
  cwd: string,
  /** Paths are confined here; defaults to `cwd`. The engine passes the session root. */
  sessionRoot: string = cwd,
): ConditionEvaluation {
  try {
    const conditionBudget = conditionStringBudget(cond, undefined);
    if (conditionBudget.error) return { result: false, detail: `${conditionBudget.error} → false` };
    switch (cond.kind) {
      case "exitCode": {
        const result = compareInt(output.exitCode, cond.op, cond.value);
        return {
          result,
          detail: `exit ${OP_SYM[cond.op] ?? cond.op} ${cond.value} → ${result} (exit was ${output.exitCode})`,
        };
      }

      case "fileExists": {
        const label = `file ${cond.negate ? "missing" : "exists"} ${cond.path}`;
        const target = resolve(cwd, cond.path);
        // Refused either way, negate included: a plan must not probe the
        // filesystem outside the session root through a condition.
        if (!isInsideRoot(canonicalPath(resolve(sessionRoot)), canonicalPath(target))) {
          return { result: false, detail: `${label} → false (${target} is outside session root)` };
        }
        const exists = existsSync(target);
        const result = cond.negate ? !exists : exists;
        return {
          result,
          detail: `${label} → ${result} (${target} ${exists ? "exists" : "is missing"})`,
        };
      }

      case "jsonPath": {
        const label = `jsonPath ${cond.path} ${cond.op}${cond.op === "exists" ? "" : ` ${showValue(cond.value)}`}`;
        if (output.stdoutTruncated) {
          return { result: false, detail: `${label} → false (stdout was truncated; JSON may be incomplete)` };
        }
        let data: unknown;
        try {
          data = JSON.parse(output.stdout) as unknown;
        } catch {
          return { result: false, detail: `${label} → false (stdout is not valid JSON)` };
        }
        const { found, value } = getJsonPath(data, cond.path);
        let result: boolean;
        if (cond.op === "exists") result = found;
        else if (!found) result = cond.op === "ne"; // missing != any concrete value
        else if (cond.op === "eq") result = deepEqual(value, cond.value);
        else result = !deepEqual(value, cond.value); // "ne"
        const observed = found ? `value was ${showValue(value)}` : `path not found in stdout JSON`;
        return { result, detail: `${label} → ${result} (${observed})` };
      }

      case "numeric": {
        const label = `numeric /${cond.extract}/ ${OP_SYM[cond.op] ?? cond.op} ${cond.value}`;
        if (output.stdoutTruncated) {
          return { result: false, detail: `${label} → false (stdout was truncated; number may be outside retained output)` };
        }
        if (!isSafeRegex(cond.extract)) {
          return { result: false, detail: `${label} → false (extract regex rejected: nested quantifier may not terminate)` };
        }
        const run = execWithDeadline(new RegExp(cond.extract), output.stdout);
        if (run.timedOut) return { result: false, detail: `${label} → false (${TIMED_OUT_DETAIL})` };
        const m = run.match;
        if (!m) return { result: false, detail: `${label} → false (regex matched nothing in stdout)` };
        const raw = m[1] ?? m[0];
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          return { result: false, detail: `${label} → false (extracted ${showValue(raw)}, not a number)` };
        }
        const result = compareFloat(n, cond.op, cond.value);
        return { result, detail: `${label} → ${result} (extracted ${n})` };
      }

      case "match": {
        const sourceName = cond.source === "stderr" ? "stderr" : "stdout";
        const source = cond.source === "stderr" ? output.stderr : output.stdout;
        const sourceTruncated = cond.source === "stderr" ? output.stderrTruncated : output.stdoutTruncated;
        if (cond.negate && sourceTruncated) {
          return {
            result: false,
            detail: `${sourceName} !~ /${cond.regex}/ → false (${sourceName} was truncated; absence cannot be established)`,
          };
        }
        if (!isSafeRegex(cond.regex)) {
          return {
            result: false,
            detail: `${sourceName} ${cond.negate ? "!~" : "=~"} /${cond.regex}/ → false (regex rejected: nested quantifier may not terminate)`,
          };
        }
        const matchSource = sourceTruncated ? source.replace(SYNTHETIC_TRUNCATION_MARKER_RE, "") : source;
        const run = execWithDeadline(new RegExp(cond.regex), matchSource);
        if (run.timedOut) {
          // Not matched either way: a timeout establishes neither presence nor absence.
          return { result: false, detail: `${sourceName} ${cond.negate ? "!~" : "=~"} /${cond.regex}/ → false (${TIMED_OUT_DETAIL})` };
        }
        const hit = run.match !== null;
        const result = cond.negate ? !hit : hit;
        return {
          result,
          detail: `${sourceName} ${cond.negate ? "!~" : "=~"} /${cond.regex}/ → ${result} (${hit ? "matched" : `no match in ${matchSource.length}-char ${sourceName}`})`,
        };
      }

      case "always":
        return { result: true, detail: "always → true" };

      default: {
        // Exhaustiveness guard: an unknown kind is a benign miss, but SAY so.
        const _never: never = cond;
        void _never;
        const kind = (cond as { kind?: unknown }).kind;
        return { result: false, detail: `unknown condition kind ${showValue(kind)} → false` };
      }
    }
  } catch {
    return { result: false, detail: "condition evaluation threw → false" };
  }
}

function compareInt(actual: number, op: "eq" | "ne" | "lt" | "gt", value: number): boolean {
  switch (op) {
    case "eq":
      return actual === value;
    case "ne":
      return actual !== value;
    case "lt":
      return actual < value;
    case "gt":
      return actual > value;
  }
}

function compareFloat(actual: number, op: "lt" | "le" | "gt" | "ge" | "eq", value: number): boolean {
  switch (op) {
    case "lt":
      return actual < value;
    case "le":
      return actual <= value;
    case "gt":
      return actual > value;
    case "ge":
      return actual >= value;
    case "eq":
      return actual === value;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[a, b]];
  let work = 0;
  while (pending.length > 0) {
    if (++work > MAX_JSON_VALUE_NODES) return false;
    const [left, right] = pending.pop()!;
    if (left === right) continue;
    if (typeof left !== typeof right || left === null || right === null) return false;
    if (typeof left !== "object") return false;
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
      for (let index = 0; index < left.length; index++) pending.push([left[index], right[index]]);
      continue;
    }
    const leftObject = left as Record<string, unknown>;
    const rightObject = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftObject);
    const rightKeys = Object.keys(rightObject);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(rightObject, key)) return false;
      pending.push([leftObject[key], rightObject[key]]);
    }
  }
  return true;
}

/**
 * Walk a simple dot/bracket JSON path, e.g. `a.b[0].c` or `items[2]`.
 * Returns whether the path resolved and, if so, the value at it.
 */
function getJsonPath(data: unknown, path: string): { found: boolean; value: unknown } {
  const trimmed = path.replace(/^\$\.?/, ""); // tolerate a leading `$` or `$.`
  if (trimmed === "") return { found: true, value: data };

  const tokens = trimmed.match(/[^.[\]]+/g);
  if (!tokens) return { found: true, value: data };

  let cur: unknown = data;
  for (const token of tokens) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
    } else if (typeof cur === "object") {
      const obj = cur as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, token)) return { found: false, value: undefined };
      cur = obj[token];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}
