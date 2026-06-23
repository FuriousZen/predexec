/**
 * predexec core — deterministic condition-DSL evaluator.
 *
 * evaluateCondition is total and exception-safe: a malformed condition (bad
 * regex, unparseable JSON, missing file) evaluates to `false`, never throwing.
 * A thrown exception mid-walk would be a silent false-hit hazard; returning
 * false instead degrades to a benign miss (no edge matches => fallback).
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Condition, NodeOutput } from "./types.ts";

const EXIT_RE = /^exit\s*(==|!=|>|<)\s*(\d+)$/;
const MATCH_RE = /^(stdout|stderr)\s*(=~|!~)\s*\/(.+)\/$/;
const FILE_RE = /^file\s+(exists|missing)\s+(.+)$/;

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

export function evaluateCondition(output: NodeOutput, cond: Condition, cwd: string): boolean {
  try {
    switch (cond.kind) {
      case "exitCode":
        return compareInt(output.exitCode, cond.op, cond.value);

      case "fileExists": {
        const target = isAbsolute(cond.path) ? cond.path : resolve(cwd, cond.path);
        const exists = existsSync(target);
        return cond.negate ? !exists : exists;
      }

      case "jsonPath": {
        const data = JSON.parse(output.stdout) as unknown;
        const { found, value } = getJsonPath(data, cond.path);
        if (cond.op === "exists") return found;
        if (!found) return cond.op === "ne"; // missing != any concrete value
        if (cond.op === "eq") return deepEqual(value, cond.value);
        return !deepEqual(value, cond.value); // "ne"
      }

      case "numeric": {
        const m = new RegExp(cond.extract).exec(output.stdout);
        if (!m) return false;
        const raw = m[1] ?? m[0];
        const n = Number(raw);
        if (!Number.isFinite(n)) return false;
        return compareFloat(n, cond.op, cond.value);
      }

      case "match": {
        const source = cond.source === "stderr" ? output.stderr : output.stdout;
        const hit = new RegExp(cond.regex).test(source);
        return cond.negate ? !hit : hit;
      }

      case "always":
        return true;

      default: {
        // Exhaustiveness guard: an unknown kind is treated as a benign miss.
        const _never: never = cond;
        void _never;
        return false;
      }
    }
  } catch {
    return false;
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
