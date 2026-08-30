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

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  MAX_CONDITION_LENGTH,
  MAX_CONDITION_TOTAL_LENGTH,
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
 * The screen is intentionally conservative: it rejects a quantified group
 * whose body ends open-ended — `(a+)+`, `([a-z]+)+`, `(\w+\s*)+` — and a
 * quantified alternation whose branches can consume the same prefix. The
 * latter is the ambiguity behind patterns such as `(a|aa)+` and `(a|a?)+`.
 * A body ending in a fixed atom is still allowed, so ordinary matchers like
 * `(?:\d+\.)+\d+` remain usable.
 */
const SYNTHETIC_TRUNCATION_MARKER_RE = /…\[truncated(?:: \d+ more chars)?\]/g;

/** Check edge-authored strings before any parser, compiler, or evaluator sees them. */
export function conditionStringBudget(
  when: unknown,
  edgeTo: unknown,
  currentTotal = 0,
): { total: number; error: string | null } {
  const parts: Array<{ label: string; value: string; limit: number }> = [];
  if (typeof when === "string") {
    parts.push({ label: "condition string", value: when, limit: MAX_CONDITION_LENGTH });
  } else if (when && typeof when === "object") {
    for (const [key, value] of Object.entries(when)) {
      if (typeof value === "string") parts.push({ label: `condition ${key}`, value, limit: MAX_CONDITION_LENGTH });
    }
  }
  if (typeof edgeTo === "string") parts.push({ label: "edge target", value: edgeTo, limit: MAX_NODE_ID_LENGTH });

  let total = currentTotal;
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
}

interface RegexSequence {
  atoms: RegexAtom[];
  nullable: boolean;
  first: RegexCharSet;
  endsOpenEnded: boolean;
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

function escapeSet(ch: string): RegexCharSet {
  if (ch === "d") return ASCII_DIGITS;
  if (ch === "D") return "any";
  if (ch === "w") return ASCII_WORD;
  if (ch === "W") return "any";
  if (ch === "s") return ASCII_SPACE;
  if (ch === "S" || ch === "p" || ch === "P") return "any";
  return new Set(ch);
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

function readQuantifier(source: string, start: number): { next: number; optional: boolean; openEnded: boolean } {
  const ch = source[start];
  if (ch === "+" || ch === "*") return { next: start + 1, optional: ch === "*", openEnded: true };
  if (ch === "?") return { next: start + 1, optional: true, openEnded: false };
  if (ch !== "{") return { next: start, optional: false, openEnded: false };
  const end = source.indexOf("}", start + 1);
  if (end < 0) return { next: start, optional: false, openEnded: false };
  const quantifier = source.slice(start + 1, end);
  const min = Number.parseInt(quantifier.split(",", 1)[0] ?? "", 10);
  return { next: end + 1, optional: min === 0, openEnded: quantifier.endsWith(",") };
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
    if (ch === "\\") {
      atomFirst = escapeSet(source[i + 1] ?? "");
      i += 2;
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
        const prefix = source.slice(i + 1, end).match(/^\?(?::|[=!]|<[=!]?[^>]*>)/)?.[0] ?? "";
        const nested = parseAlternativesSequence(source.slice(i + 1 + prefix.length, end));
        atomFirst = nested.first;
        nestedNullable = nested.nullable;
        nestedEndsOpenEnded = nested.endsOpenEnded;
        i = end + 1;
      }
    } else {
      atomFirst = ch === "." ? "any" : new Set(ch);
      i += 1;
    }
    const quantifier = readQuantifier(source, i);
    i = quantifier.next;
    const optional = quantifier.optional || nestedNullable;
    atoms.push({ first: atomFirst, optional, quantifiedOpenEnded: quantifier.openEnded || nestedEndsOpenEnded });
    if (firstCanContinue) {
      first = unionCharSets(first, atomFirst);
      firstCanContinue = optional;
    }
    if (!optional) nullable = false;
  }
  return { atoms, nullable, first, endsOpenEnded: atoms.at(-1)?.quantifiedOpenEnded ?? false };
}

function parseAlternativesSequence(body: string): RegexSequence {
  const alternatives = splitAlternatives(body);
  let first: RegexCharSet = new Set();
  let nullable = false;
  let endsOpenEnded = false;
  for (const alternative of alternatives) {
    const shape = parseSequence(alternative);
    first = unionCharSets(first, shape.first);
    nullable ||= shape.nullable;
    endsOpenEnded ||= shape.endsOpenEnded;
  }
  return { atoms: [], nullable, first, endsOpenEnded };
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
    const quantifier = readQuantifier(pattern, end + 1);
    if (quantifier.next === end + 1 || !quantifier.openEnded && pattern[end + 1] !== "+" && pattern[end + 1] !== "*") continue;
    const body = pattern.slice(i + 1, end).replace(/^\?(?::|[=!]|<[=!]?[^>]*>)/, "");
    if (/(?:[+*]|\{\d+,\})\s*$/.test(body) || ambiguousAlternation(body)) return false;
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
  try {
    const s = JSON.stringify(v);
    const text = s === undefined ? String(v) : s;
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  } catch {
    return String(v);
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
        const target = isAbsolute(cond.path) ? cond.path : resolve(cwd, cond.path);
        const exists = existsSync(target);
        const result = cond.negate ? !exists : exists;
        return {
          result,
          detail: `file ${cond.negate ? "missing" : "exists"} ${cond.path} → ${result} (${target} ${exists ? "exists" : "is missing"})`,
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
        const m = new RegExp(cond.extract).exec(output.stdout);
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
        const hit = new RegExp(cond.regex).test(matchSource);
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
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
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
