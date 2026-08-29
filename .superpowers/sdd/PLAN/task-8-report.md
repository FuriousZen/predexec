# Task 8 report — enforce host policy for tool operations

## Outcome

Implemented the operation-wide policy seam. `OperationPolicyChecker` is now a
core type and `runPlanTree` invokes it for every operation in a node before any
node item runs. Native policy blocks render the operation with
`formatToolOpLabel`; existing shell/Bash checking and verdict strings remain
compatible (the deprecated `checkCommandPolicy` option is retained as a
compatibility bridge for existing callers).

## Supported policy shapes

- Claude settings `permissions.deny`/`ask`/`allow` entries for `Read(...)`,
  `Grep(...)`, and `Glob(...)`. `Read` governs `read` and `ls`, `Grep` governs
  `grep`, and `Glob` governs `find`. Existing Claude Bash parsing and its
  deny-before-ask precedence are unchanged.
- opencode `permission.read`, `permission.grep`, and `permission.list` pattern
  maps. `read`, `grep`, and `list` govern the corresponding native operations;
  `list` also covers `find` and `ls`. Existing Bash parsing and last-match-wins
  precedence are unchanged.
- Codex continues to govern only shell strings and `{tool:"bash"}` operations;
  no persisted Codex file-operation policy source was invented.
- Pi is unchanged and supplies no additional persisted policy checker.

Unreadable configured policy files fail closed for the operations governed by
the relevant adapter. Unsupported/native tool shapes are not assigned a host
rule and continue to the core's existing tool validation/execution path.

## TDD evidence

- RED: focused engine, policy, Claude, and adapter tests initially failed due to
  the missing `checkOperationPolicy` seam and native parsers.
- GREEN: focused policy/MCP/core suite passed: 206 tests.
- Full suite: 706 tests passed.
- Typecheck: `./node_modules/.bin/tsc --noEmit` passed.
- Build: `pnpm run build` passed.
- Diff check: `git diff --check` passed.

## Self-review

- Policy runs after mutation classification and cwd validation, before execution.
- The checker is called for all operations even when an earlier operation has a
  violation; the first violation determines the hard-stop transcript.
- Shell strings and full Bash objects remain visible to adapters; native tools
  are mapped only through documented/local fixture shapes.
- No Pi files, Task 9 files, ledger files, or Task 1–7 implementation files were
  modified.
