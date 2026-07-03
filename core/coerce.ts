/**
 * predexec core — plan coercion & validation utilities.
 *
 * Shared by all adapters. Defensively recovers double-encoded JSON
 * (common with free-tier models) and parses string condition shorthands.
 */

import { parseConditionString } from "./conditions.ts";
import type { PlanTree } from "./types.ts";

const VALID_KINDS = "exitCode | fileExists | jsonPath | numeric | match | always";

const compilesAsRegex = (s: string): boolean => {
  try {
    new RegExp(s);
    return true;
  } catch {
    return false;
  }
};

/**
 * Structural validation for OBJECT conditions at coerce (authoring) time.
 * The runtime evaluator is exception-safe and degrades malformed conditions to
 * a silent benign `false` — correct for the walk, terrible feedback for the
 * author. This surfaces those errors loudly instead, mirroring what
 * parseConditionString already does for string shorthands. Returns an error
 * message or null; may FILL a missing `source` (the evaluator reads stdout by
 * default anyway). Extra fields are tolerated (pi's loose schema sends them).
 */
export function validateConditionObject(when: Record<string, unknown>): string | null {
  switch (when.kind) {
    case "exitCode":
      if (!["eq", "ne", "lt", "gt"].includes(when.op as string) || typeof when.value !== "number") {
        return "exitCode requires op (eq|ne|lt|gt) and a numeric value";
      }
      return null;
    case "fileExists":
      return typeof when.path === "string" ? null : "fileExists requires a string path";
    case "jsonPath":
      if (typeof when.path !== "string" || !["eq", "ne", "exists"].includes(when.op as string)) {
        return "jsonPath requires a string path and op (eq|ne|exists)";
      }
      if (when.source === undefined) when.source = "stdout";
      return null;
    case "numeric":
      if (typeof when.extract !== "string" || !compilesAsRegex(when.extract)) {
        return "numeric requires a string `extract` that compiles as a regex";
      }
      if (!["lt", "le", "gt", "ge", "eq"].includes(when.op as string) || typeof when.value !== "number") {
        return "numeric requires op (lt|le|gt|ge|eq) and a numeric value";
      }
      if (when.source === undefined) when.source = "stdout";
      return null;
    case "match":
      if (typeof when.regex !== "string" || !compilesAsRegex(when.regex)) {
        return "match requires a string `regex` that compiles";
      }
      if (when.source === undefined) when.source = "stdout";
      if (!["stdout", "stderr"].includes(when.source as string)) {
        return "match source must be stdout or stderr";
      }
      return null;
    case "always":
      return null;
    default:
      return `unknown condition kind ${JSON.stringify(when.kind)}. Valid kinds: ${VALID_KINDS}`;
  }
}

/**
 * Free-tier models routinely emit nested JSON as a STRING (e.g. `nodes` arrives
 * double-encoded, or the whole argument object is stringified). Recover
 * defensively: parse a stringified plan or a stringified `nodes`, and on failure
 * return a message that says what shape was expected instead of a validator dump.
 */
export function coercePlan(params: unknown): PlanTree {
  let p: unknown = params;
  if (typeof p === "string") p = parseOrThrow(p, "plan");
  if (p && typeof p === "object" && typeof (p as { nodes?: unknown }).nodes === "string") {
    p = { ...(p as object), nodes: parseOrThrow((p as { nodes: string }).nodes, "nodes") };
  }
  const plan = p as PlanTree;
  if (!plan || typeof plan !== "object" || typeof plan.root !== "string" || !Array.isArray(plan.nodes)) {
    throw new Error(
      "predexec expected a JSON object with `root` (string) and `nodes` (array of {id, commands[]}). " +
      "Pass the plan as an object, not a string.",
    );
  }
  for (const node of plan.nodes) {
    if (!node.edges) continue;
    for (const edge of node.edges) {
      if (typeof edge.when === "string") {
        const parsed = parseConditionString(edge.when);
        if (!parsed) {
          throw new Error(
            `predexec could not parse condition string "${edge.when}" on edge from "${node.id}". ` +
            `Use: "exit == 0", "stdout =~ /pattern/", "file exists path", "always", or an object.`,
          );
        }
        (edge as { when: unknown }).when = parsed;
      } else if (edge.when && typeof edge.when === "object") {
        const problem = validateConditionObject(edge.when as Record<string, unknown>);
        if (problem) {
          throw new Error(`predexec: invalid condition on edge from "${node.id}": ${problem}.`);
        }
      } else {
        throw new Error(
          `predexec: edge from "${node.id}" has a ${typeof edge.when} \`when\` — ` +
          `use a condition string or object.`,
        );
      }
    }
  }
  return plan;
}

function parseOrThrow(s: string, what: string): unknown {
  try {
    return JSON.parse(s);
  } catch (err) {
    throw new Error(`predexec could not parse \`${what}\` as JSON: ${(err as Error).message}`);
  }
}
