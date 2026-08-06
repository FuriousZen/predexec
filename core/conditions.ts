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
import type { Condition, NodeOutput } from "./types.ts";

const EXIT_RE = /^exit\s*(==|!=|>|<)\s*(\d+)$/;
// Greedy `(.+)` with the `$` anchor takes everything between the first and last
// `/`, which is what a regex containing a literal slash needs.
const MATCH_RE = /^(stdout|stderr)\s*(=~|!~)\s*\/(.+)\/$/;
const FILE_RE = /^file\s+(exists|missing)\s+(.+)$/;

/**
 * Reject regexes prone to catastrophic backtracking.
 *
 * Best-effort and deliberately narrow: it rejects a quantified group whose body
 * ENDS open-ended — `(a+)+`, `([a-z]+)+`, `(\w+\s*)+`, `(\d+){2,}` — the shape
 * behind essentially every practical ReDoS. A body ending in a fixed atom is
 * anchored and allowed, so ordinary matchers like `(?:\d+\.)+\d+` still work.
 *
 * It does NOT catch quantified overlapping alternation like `(a|a)+`. A real
 * fix needs a timeout the JS RegExp engine does not offer, so this narrows the
 * gap rather than closing it.
 */
const QUANTIFIED_GROUP_RE = /\(([^)]*)\)\s*(?:[+*]|\{\d)/g;

export function isSafeRegex(pattern: string): boolean {
  QUANTIFIED_GROUP_RE.lastIndex = 0;
  for (let m = QUANTIFIED_GROUP_RE.exec(pattern); m; m = QUANTIFIED_GROUP_RE.exec(pattern)) {
    const body = (m[1] ?? "").replace(/^\?[:=!]|^\?<[=!]?[^>]*>/, "");
    // Unsafe only when the repeated body ITSELF ends open-ended — `(a+)+`,
    // `([a-z]+)+`, `(\w+\s*)+`. Then each outer repetition can split the same
    // input many ways and the engine explores all of them.
    //
    // A body ending in a fixed atom is anchored and safe: in `(?:\d+\.)+` every
    // iteration must consume a literal `.`, so there is nothing to backtrack
    // over. Rejecting those would turn ordinary version/path matchers into
    // permanently-false edges.
    if (/[+*]$|\{\d+,\}$/.test(body)) return false;
  }
  return true;
}

const EXIT_OP: Record<string, "eq" | "ne" | "gt" | "lt"> = {
  "==": "eq", "!=": "ne", ">": "gt", "<": "lt",
};

export function parseConditionString(s: string): Condition | null {
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
        if (!isSafeRegex(cond.regex)) {
          return {
            result: false,
            detail: `${sourceName} ${cond.negate ? "!~" : "=~"} /${cond.regex}/ → false (regex rejected: nested quantifier may not terminate)`,
          };
        }
        const hit = new RegExp(cond.regex).test(source);
        const result = cond.negate ? !hit : hit;
        return {
          result,
          detail: `${sourceName} ${cond.negate ? "!~" : "=~"} /${cond.regex}/ → ${result} (${hit ? "matched" : `no match in ${source.length}-char ${sourceName}`})`,
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

export function evaluateCondition(output: NodeOutput, cond: Condition, cwd: string): boolean {
  return evaluateConditionWithDetail(output, cond, cwd).result;
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
