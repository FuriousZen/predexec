# Task 8 report — enforce host policy for tool operations

## Outcome

Implemented the operation-wide policy seam. `OperationPolicyChecker` is now a
core type and `runPlanTree` invokes it for every operation in a node before any
node item runs. Native policy blocks render the operation with
`formatToolOpLabel`; existing shell/Bash checking and verdict strings remain
compatible. The old `checkCommandPolicy` option and all repository callers were
removed.

## Supported policy shapes

- Claude settings `permissions.deny`/`ask`/`allow` entries for `Read(...)`,
  `Grep(...)`, and `Glob(...)`. `Read` governs `read` and `ls`, `Grep` governs
  `grep`, and `Glob` governs `find`. Existing Claude Bash parsing and its
  deny-before-ask precedence are unchanged.
- opencode documented `permission.read`, `permission.grep`, and
  `permission.glob` pattern maps, plus documented scalar tool actions,
  top-level scalar permission, and global `permission["*"]` rules. `read`
  matches the requested path, `grep` matches the requested regex pattern, and
  `glob` matches the requested glob pattern. Local legacy `permission.list`
  remains supported for `ls` (and `find` as a compatibility alias). Effective
  rules retain opencode last-match-wins precedence independently per tool.
- Codex continues to govern only shell strings and `{tool:"bash"}` operations;
  no persisted Codex file-operation policy source was invented.
- Pi is unchanged and supplies no additional persisted policy checker.

Unreadable configured policy files fail closed for the operations governed by
the relevant adapter. Unsupported/native tool shapes are not assigned a host
rule and continue to the core's existing tool validation/execution path.
Native relative targets are normalized by the engine into the session-root
namespace before checking (for example, plan `cwd: "sub"` plus `.env` checks as
`sub/.env`); execution still receives `.env` under the effective cwd.
Native policy stops recommend the host's native file/search tool, while shell
stops retain their host Bash recovery text. Codex's description explicitly
states that it has no persisted native file-operation source.

## TDD evidence

- RED: focused engine, policy, Claude, and adapter tests initially failed due to
- the missing `checkOperationPolicy` seam and native parsers, then round-1
  regressions failed for cwd normalization, transcript recovery text, legacy API
  removal, documented opencode shapes, Claude global `*`, and host-specific
  descriptions.
- GREEN: focused policy/MCP/core/adapter suite passed: 254 tests.
- Full suite: 713 tests passed.
- Typecheck: `./node_modules/.bin/tsc --noEmit` passed.
- Build: `pnpm run build` passed.
- Diff check: `git diff --check` passed.

## Self-review

- Policy runs after mutation classification and cwd validation, before execution.
- The checker is called for all operations even when an earlier operation has a
  violation; the first violation determines the hard-stop transcript.
- Shell strings and full Bash objects remain visible to adapters; native tools
  are mapped only through documented/local fixture shapes.
- Read/parse discovery distinguishes absent `ENOENT` paths from permission,
  directory, and parse failures; the latter are reported as unreadable and fail
  closed for governed operations.
- No Pi files, Task 9 files, ledger files, or Task 1–7 implementation files were
  modified.

## Round 1/5 findings addressed

All seven requested items were covered by RED regressions and GREEN fixes:

1. Nested plan cwd policy bypass — fixed at the core checker boundary and covered
   by Claude and opencode e2e tests.
2. Native transcript recovery — native stops no longer advise host Bash.
3. Legacy API — removed from `RunOptions`, engine, and all callers/tests.
4. OpenCode resource fields — `read`, `grep`, `glob`, scalar/global forms, and
   local `list` compatibility are tested; grep uses the requested pattern field.
5. Claude global `*` — maps to all supported native operations and is tested.
6. Host-specific MCP description — Claude and Codex descriptions now state their
   distinct policy coverage.
7. File read races/errors — `ENOENT` is treated as absent; other read/parse
   failures are retained as unreadable and fail closed.

Evidence: the [OpenCode permissions documentation](https://opencode.ai/docs/permissions/)
defines global `*`/scalar permissions, last-match-wins object rules, and the
resource fields `read` (file path), `grep` (regex pattern), and `glob` (glob
pattern). Local adapter contract and fixture tests in
`__tests__/policy.test.ts` and `__tests__/opencode.test.ts` pin those mappings;
the legacy `list` alias is explicitly local compatibility rather than an
official-only claim.
