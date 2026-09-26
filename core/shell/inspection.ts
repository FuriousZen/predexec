/**
 * Harness-neutral shell inspection API — a thin layer over `lexer.ts`.
 *
 * These are the entry points the host policy adapters and tests use:
 * substitution and clause inspection, argv tokenizing, and wrapper stripping
 * with a host-supplied vocabulary. The mechanics (and core's own `WRAPPERS`)
 * live in `lexer.ts`; this module adds no behavior of its own.
 */

export {
  extractCommandSubstitutions,
  extractShellCommandClauses,
  inspectCommandSubstitutions,
  inspectCommandSubstitutionTree,
  inspectShellCommandClauses,
  lexShellWords,
  splitCommandSegments,
  stripLeadingAssignmentsAndWrappers,
  tokenizeShellWords,
  type CommandSubstitutionInspection,
  type CommandSubstitutionTree,
  type ExecutableBodyTreeOptions,
  type ShellClauseInspection,
  type ShellWord,
  type WrapperInspectionOptions,
} from "./lexer.ts";
