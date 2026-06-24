/**
 * predexec core — plan coercion & validation utilities.
 *
 * Shared by all adapters. Defensively recovers double-encoded JSON
 * (common with free-tier models) and parses string condition shorthands.
 */

import { parseConditionString } from "./conditions.ts";
import type { PlanTree } from "./types.ts";

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
