# Task 9 report — command inspection and plan-language consolidation

## Scope

Task 9 started from `de177f528c754d09ebd38fd41acf95c718b23256` in the
`audit-remediation` worktree. The requested brief and progress ledger were
found at `.superpowers/sdd/PLAN/task-9-brief.md` and
`.superpowers/sdd/PLAN/progress.md` (not at the repository root).

## TDD evidence

### RED

Added `__tests__/command-inspection.test.ts` and
`__tests__/plan-language.test.ts` before creating their production modules.
The focused run failed as expected with two module-not-found failures:

```text
Error: Cannot find module '../command-inspection.ts'
Error: Cannot find module '../plan-language.ts'
```

### GREEN

Created the two modules and ran the parity tests: **11/11 passed**. The
focused policy/adapter run then passed **239/239**, and the final focused
adapter run passed **123/123** after adding registration-surface assertions.

The full suite passed **726/726 tests**.

## What changed

- `command-inspection.ts` now owns only mechanics proven identical by parity
  tests: command substitution extraction, shell-word tokenization, and bounded
  assignment/wrapper stripping. It supports both raw-string (Claude glob
  matching) and token-array (Codex prefix matching) forms.
- Claude and Codex retain private host wrapper sets and pass those sets to the
  shared mechanic. Their policy parsing, matching, precedence, rule loading,
  and verdict selection remain separate.
- `plan-language.ts` centralizes immutable condition/tool vocabularies, the
  existing resource ceilings, the JSON-path single-operation rule, and the
  canonical plan-shape description.
- MCP and opencode compose the canonical plan description with their existing
  adapter notes. Pi uses the shared condition/tool/limit constants for its
  schema while retaining its intentionally different wording and projection.
- `steering.ts` re-exports the JSON-path fact for compatibility. Existing
  source-level release-hygiene checks continue to find the shared symbol via
  traceability comments in MCP/opencode.

## Deletion test

Removed the duplicated substitution scanners, Codex tokenizer, and both
adapters' assignment/wrapper loops. No host policy parser, pattern parser,
ordering rule, or verdict calculation moved into the shared module. The
remaining `stripBashWrappers` export is retained as an existing test/API seam;
it delegates with Claude's private wrapper vocabulary and does not define
shared policy behavior.

## Verification

- `./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/plan-language.test.ts`: 11/11
- Focused policy and adapter tests: 239/239, then 123/123 with registration assertions
- `./node_modules/.bin/vitest run`: 726/726
- `pnpm run typecheck`: passed
- `pnpm run build`: passed
- `pnpm pack --dry-run`: passed; packed dist contains both new compiled modules
- `git diff --check`: passed

## Behavior parity and concerns

The existing Claude wrapper tests, Codex policy tests, and all adapter tests
remain green. Claude still matches raw and wrapper-stripped forms; Codex still
matches raw and stripped token forms with most-restrictive-wins precedence.
Substitution, quoting, newline, assignment, and wrapper behavior is covered by
the new mechanical parity tests.

`policy.ts` had no duplicated inspection mechanics to extract and therefore
did not need a production change; its opencode-specific parsing and
last-match-wins behavior was intentionally left untouched.

## Commit

Planned commit message: `refactor: centralize command and plan language mechanics`
