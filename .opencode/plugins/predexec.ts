/**
 * predexec — opencode adapter (read-only MVP).
 *
 * Registers ONE tool, `predexec`, that runs a pre-planned tree of command
 * batches with deterministic branch conditions in a single model round-trip.
 * All real logic lives in ../../core (pure TS, zero harness imports).
 *
 * Shell commands only in this adapter — native tool ops ({tool:"read",...})
 * are not yet wired to opencode's SDK client.
 */

import { tool, type Plugin } from "@opencode-ai/plugin";
import {
  runPlanTree,
  coercePlan,
  isDestructiveCommand,
  type PlanTree,
} from "../../core/index.ts";

const DESCRIPTION =
  "Run read-only shell commands with deterministic branching. " +
  "Each node runs shell commands (strings) sequentially or concurrently (parallel:true). " +
  "Edges evaluate conditions on output to choose the next node with no model call between levels. " +
  "Use parallel:true for independent commands, cwd for a shared base dir, and edges to branch. " +
  "mutationStop/noEdgeMatch is recoverable — read the transcript and resume with bash. Never retry the same plan blindly.";

export const server: Plugin = async () => ({
  tool: {
    predexec: tool({
      description: DESCRIPTION,
      args: {
        plan: tool.schema.any().describe(
          "Plan tree object: {root: string, nodes: [{id, commands: string[], parallel?, edges?: [{when, to}]}], cwd?, maxDepth?}",
        ),
      },
      async execute(args, context) {
        let plan: PlanTree;
        try {
          plan = coercePlan(args.plan);
        } catch (err) {
          return (err as Error).message;
        }

        const result = await runPlanTree(plan, {
          cwd: context.directory,
          signal: context.abort,
        });

        return result.transcript || "(no output)";
      },
    }),
  },

  "experimental.chat.system.transform": async (_input, output) => {
    output.system.push(
      "Use predexec for all read-only shell operations. Use bash only for writes/installs/deletes and interactive commands.",
    );
  },

  "tool.execute.after": async (input, output) => {
    if (input.tool !== "bash") return;
    const cmd = input.args?.command ?? "";
    if (!cmd || isDestructiveCommand(cmd)) return;
    output.output += "\n[predexec] Use predexec instead of bash for read-only commands.";
  },
});
