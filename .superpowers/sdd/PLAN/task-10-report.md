# Task 10 report — cross-adapter release verification

## Scope and baseline

- Worktree: `audit-remediation`
- Required starting/verified HEAD: `0a2b00e792660e926204254e818776e8c6822cd4`
- Merge-base for the whole-branch review package: `b8e4daa865691a9f0a735d1cc823270532c6d870`
- No publish, push, merge, version bump, ledger edit, or source correction was performed.
- The task brief and ledger were read from `.superpowers/sdd/PLAN/`; neither exists at the repository root.

## Verification evidence

Every command required by `task-10-brief.md` was run from this worktree.

### Focused invariant suites

```text
./node_modules/.bin/vitest run __tests__/core __tests__/policy.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts __tests__/mcp/tool-ops.test.ts __tests__/mcp/server.test.ts __tests__/pi.test.ts __tests__/opencode.test.ts __tests__/stats.test.ts
```

Result: exit 0; **12 test files passed, 589 tests passed**. No tests were skipped in this run.

### Static, runtime, build, and packed release checks

```text
./node_modules/.bin/tsc --noEmit
```

Result: exit 0, no diagnostics.

```text
./node_modules/.bin/vitest run
```

Result: exit 0; **21 test files passed, 727 tests passed**.

```text
pnpm run build
```

Result: exit 0 (`tsc -p tsconfig.build.json`).

```text
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
```

Result: exit 0; **2 test files passed, 9 tests passed**. The pack suite created and installed a real `predexec@0.4.0` tarball with `npm install --omit=dev`; its 30-file package contains compiled ESM entries, both binaries, skills/configs, and README, and the fresh install resolved `@modelcontextprotocol/server` while excluding the pi dev dependency. The installed CLI and MCP stdio initialize/list/call smoke tests passed.

## Scope and release-surface audit

Commands:

```text
git diff --check
git status --short --untracked-files=all
git log --oneline --decorate -15
```

`git diff --check` passed. Before this report was created, the worktree status was clean. The latest 15 commits are the Task 1–9 implementation/fix commits ending at `0a2b00e`; no Task 10 source correction was needed.

- `git diff b8e4daa..HEAD -- package.json pnpm-lock.yaml` is empty. Runtime dependencies remain exactly `@modelcontextprotocol/server` and `zod`; no production dependency was added.
- `core/` imports only Node built-ins (`node:child_process`, `node:fs`, `node:path`) and internal core modules. No harness package or third-party runtime import entered `core/`.
- `git ls-files dist` returns no entries and `git check-ignore -v dist/core/engine.js` identifies the repository's `dist/` ignore rule. Build output is present for local pack verification but is not staged/tracked.
- `PLAN.post-0.3.1-archive.md` and `CODEX-RESEARCH.md` are not tracked in either checkout. The main checkout still reports both as untracked; current SHA-256 observations are `97f742cb769ce36b6a7cf843067d5ac4e51d218e260cbbfdaa2493bc85094990` and `39857645bb81c4366fb9964d759d2d050bfb227522b47010ebe2836f31c17084`, respectively. They were not opened for editing or modified. The worktree does not contain either file.
- No `CLAUDE.md` exists in the repository/worktree; the shipped `configs/*/AGENTS.md`, `.pi/skills/*`, adapter descriptions, and README carry the documented routing invariants.

## Documentation truthfulness

### Working directory

`resolvePlanCwd` rejects non-string/empty, absolute, and lexical `..`-escaping plan cwd values before any operation runs. A valid nested cwd becomes the one effective `RunOptions.cwd` used by shell commands, `fileExists`, Pi native factories, and MCP tool operations. The shared `PLAN_CWD_DESCRIPTION` and README describe this as a relative directory inside the session root, with absolute/escaping paths rejected. This matches implementation and tests.

### Policy

The README and adapter descriptions accurately distinguish host coverage: opencode checks Bash plus supported native `read`/`grep`/`glob` shapes (with local `list` compatibility); Claude maps supported `Read`/`Grep`/`Glob` settings to native operations while subprocess Bash remains self-enforced; Codex's persisted checker is shell/Bash-only because it has no persisted native file-operation policy source; and Pi has no separate persisted policy checker. Deny/ask/prompt-equivalent matches hard-stop before execution as described.

### Truncation and resource bounds

Shell and tool capture set structural stdout/stderr completeness flags, retain the `OUTPUT_CAP` prefix plus an explicit marker, and aggregate those flags. Conditions reject unsafe absence/numeric/JSON in incomplete stdout, while positive prefix matches remain usable; engine warnings are flag-driven. Pi progress is capped and omitted when no update callback exists. Canonical plan prose exposes operation, concurrency, depth, cwd, and JSON-path limits. The user-facing docs make no claim that omitted output is complete, so no stale public truncation claim remains.

One deferred internal wording issue remains from Task 1: the `TRUNCATION_MARKER` comment in `core/runner.ts` says the engine checks marker text, although the engine correctly checks structural flags. This is non-behavioral and was not changed during a verification-only gate.

### Symlink containment

MCP explicit targets are lexically checked, then realpath-checked after existence. A target resolving outside the session root is rejected unless its lexical path contains an exact `node_modules` segment, preserving dependency-manager symlink farms. Recursive walks do not descend symlinked directories; search results are canonicalized and post-validated. README and MCP descriptions name both the exception and the remaining non-kernel-atomic pathname race, matching the implementation and accepted Task 7 boundary ruling.

## Whole-branch review package

The review input is pinned to the verified merge-base and HEAD:

```text
git diff b8e4daa865691a9f0a735d1cc823270532c6d870...HEAD
git log b8e4daa865691a9f0a735d1cc823270532c6d870..HEAD --oneline
```

The branch diff file/line counts are dynamic and intentionally not restated here; recalculate them at the final HEAD. Existing per-task review packages are under `.superpowers/sdd/PLAN/review-*.diff`; this report records the final merge-base command and evidence for the final whole-branch reviewer. No collaboration/reviewer sub-agent facility is available in this worker, so final two-axis review adjudication remains for the parent agent's final gate.

## Extended integration fix round 10 — OpenCode shell policy, operation validation, and interpreter writers

This user-authorized extension started from `b0843f2a7a3d7bc1614238500864a6791cd5e7c5`. It closes three Important findings: OpenCode Bash policy inspection previously stopped at `splitCommandSegments` and missed executable control/substitution bodies; malformed operation objects could reach core consumers and throw; and Perl, Ruby, and PHP eval snippets could perform common filesystem writes without classification. No ledger edit, version bump, publish, push, merge, or release-artifact staging was performed.

### RED evidence

Before production changes, focused regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/policy.test.ts __tests__/opencode.test.ts __tests__/core/engine.test.ts __tests__/core/destructive.test.ts
```

The first policy/OpenCode/engine run reported **17 failed, 398 passed**: nested `if`, function, substitution, case, and group bodies bypassed OpenCode rules, and malformed operations did not produce a structural error. The interpreter extension was then run independently and reported **9 failed, 246 passed**, covering Perl `rename`/`open`, Ruby `File.*`, and PHP `file_put_contents`/`fopen` examples.

### GREEN implementation

- `policy.ts` now inspects every Bash operation through the shared bounded executable-body tree before applying the existing raw segment rules. Incomplete or over-budget executable syntax returns an actionable fail-closed policy result. Rules still evaluate in OpenCode's existing last-match-wins order, and native resource-specific checks remain unchanged. Source and compiled plugin e2e tests cover nested `curl` in `if`, substitutions, functions, cases, and groups.
- `core/validation.ts` provides a central operation-shape validator for supported `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write` discriminants, required fields, and known optional primitive fields. `validatePlan` invokes it before mutation classification, policy checks, cwd resolution, or execution, so nulls, numbers, arrays, missing/unknown tools, and malformed command/path/pattern types return `stoppedReason: "error"` and execute nothing. Existing mutating-tool behavior remains a mutation stop for well-shaped `edit`/`write` operations.
- Interpreter classification uses separate bounded scanners for Perl (`rename`, `unlink`, `open`, `truncate`, `sysopen`), Ruby (`File` and common `FileUtils` writers plus mutating `File.open` modes), and PHP (`file_put_contents`, `unlink`, `rename`, and mutating `fopen` modes). Read-only `open`, `File.read`, `FileUtils.compare_file`, `file_get_contents`, and `fopen(..., "r")` examples remain allowed. Real temporary-directory engine regressions prove blocked writer plans do not execute or create files.

### GREEN verification

Focused core/policy/OpenCode/adapter verification:

```text
./node_modules/.bin/vitest run __tests__/core __tests__/policy.test.ts __tests__/opencode.test.ts __tests__/adapter-runtime.test.ts
```

Result: exit 0; **7 test files, 514 tests passed**. Additional required checks all passed:

```text
./node_modules/.bin/tsc --noEmit
pnpm run build
./node_modules/.bin/vitest run
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
git diff --check
```

Typecheck and build succeeded; the full suite passed **996/996 tests**; release/pack verification passed **9/9 tests**; and `git diff --check` passed. The implementation and test changes were committed as `e84400f` (`fix: close round ten policy and operation gaps`); this report follows in its own commit.

### Self-review

The OpenCode policy callback now shares the same bounded tree/completeness contract as Claude/Codex while retaining its own raw matching and last-match-wins precedence. Native operation mapping is untouched. Structural validation is centralized at the engine's pre-execution validation boundary and allows adapter metadata fields while checking all fields consumed by core and current executors. Language scanners are intentionally small and word-boundary based, with read-only fixtures constraining false positives. Whole-branch diff counts remain dynamic until final HEAD because this report is appended afterward. No ledger, release metadata, dependency, publish, push, merge, or version operation changed.

## Residual concerns carried forward

These are documented/deferred findings from the completed task reports, not newly discovered release regressions:

- `resolvePlanCwd` accepts a relative cwd containing a NUL byte; the eventual spawn failure is less actionable than central cwd validation.
- A narrow false negative is possible when genuinely emitted marker-shaped text is removed from a structurally truncated stream; there is no symmetric stderr truncation regression test.
- Fallback grep context caching scales with requested context and returned matches; direct executor abort can theoretically race after the final read chunk; accelerated `rg` and fallback differ in legacy synthetic-terminal-line behavior.
- MCP pathname containment cannot be kernel-atomic against a malicious concurrent parent-directory rename/replacement with portable Node APIs; this is explicitly documented and accepted as outside the single-process threat model.
- The deferred runner comment noted above is documentation-only.

No residual concern was release-blocking under the brief's criteria during the
initial verification pass. The subsequent final-review gate is recorded below.

## Integration fix round 1 — Important findings

The final-review gate identified two integration regressions in the previously
verified adapter surface. This round started from
`0a2b00e792660e926204254e818776e8c6822cd4`.

### RED evidence

Before changing production code, the new regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/core/engine.test.ts __tests__/opencode.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Result: exit 1; **19 tests failed, 216 passed**. The failures reproduced both
Important findings: five shared-inspection time-wrapper cases, five Claude
inner-command cases, five Codex inner-command cases, one engine normalization
case, one Claude nested-`Glob` case, and two OpenCode nested-`glob` cases (the
source and compiled plugin variants).

The root causes were isolated before the fix. `normalizePolicyOperation`
prefixed `find.pattern` as though it were a filesystem scope, so a nested plan
cwd changed the requested glob before OpenCode/Claude policy matching. The
shared wrapper stripper recognized `time` but did not consume its `-f`/
`--format` or `-o`/`--output` argument values; policy matching then saw the
option/value as the command head and missed the inner command.

### GREEN implementation and regressions

- Native policy normalization now prefixes only the operation's `path`; `find`
  patterns and grep patterns remain unchanged. The core regression also checks
  read, ls, grep path, grep pattern, and find path normalization together.
- `command-inspection.ts` now accepts wrapper-specific option-argument sets,
  consumes separate values, and recognizes attached `-fVALUE`/`-oVALUE` and
  `--format=VALUE`/`--output=VALUE` forms. Claude and Codex provide the `time`
  option set while retaining their own policy parsing, precedence, and verdict
  logic.
- OpenCode source and compiled-plugin e2e regressions and Claude engine policy
  regressions verify nested native glob rules match the requested pattern.

After the fixes, the focused regression command passed **235/235 tests** after
rebuilding the compiled artifacts. The broader invariant command:

```text
./node_modules/.bin/vitest run __tests__/core __tests__/policy.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts __tests__/mcp/tool-ops.test.ts __tests__/mcp/server.test.ts __tests__/pi.test.ts __tests__/opencode.test.ts __tests__/stats.test.ts
```

passed **603/603 tests**, and `./node_modules/.bin/tsc --noEmit` passed with no
diagnostics. The full suite passed **746/746 tests**. Release verification also
passed:

```text
pnpm run build
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
```

The build succeeded and the release suites passed **9/9 tests**, including the
real packed-install smoke checks. `git diff --check` passed. Only the owning
engine, shared command-inspection module, Claude/Codex policy adapters, and
their focused regressions changed; no ledger edit, dependency change, dist
staging, publish, push, merge, or version bump was performed.

## Integration fix round 2 — Important mutation bypass

This round started from the round-1 commit `c2e6143`. Final whole-branch
review identified that the new wrapper handling correctly reached the inner
command for policy matching but caused the mutation classifier to treat an
output-bearing `time` wrapper as the safe inner command. In particular,
`/usr/bin/time -o timing.log printf hi` could create `timing.log`.

### RED evidence

Before changing production code, the classifier and engine regressions were run
with:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts __tests__/core/engine.test.ts
```

Result: exit 1; **13 tests failed, 228 passed**. Eight classifier cases
returned `null` for `/usr/bin/time -o`, `time --output`, attached
`-ofile`/`--output=file`, `env time` chains, and `-a/--append` paired with
output. Five engine cases reached a successful leaf instead of stopping before
`runNode`; each timing-file assertion confirmed the bypass could execute.

### GREEN implementation and regressions

- `core/destructive.ts` now inspects leading wrapper chains for output-bearing
  `time` options before resolving the wrapped command head. It recognizes
  absolute `/usr/bin/time`, separate and attached short/long output options,
  `env time` chains, and append paired with output.
- Format-only `-f/--format`, `-p`, append without output, and safe inner
  commands remain allowed. The classifier returns a `time` output token for an
  actionable mutation hard-stop.
- Engine regressions prove all covered output forms stop before execution and
  do not create the timing file.

The focused mutation/engine suite passed **241/241 tests**. The combined
mutation, engine, command-inspection, and Claude/Codex/OpenCode policy suites
passed **382/382 tests**. `./node_modules/.bin/tsc --noEmit` passed, and
`pnpm run build` succeeded.

The full suite passed **763/763 tests**. Release verification passed **9/9
tests**:

```text
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
```

The packed-install smoke checks passed with the rebuilt production artifacts,
and `git diff --check` passed. No ledger edit, dependency change, version bump,
publish, push, merge, or release artifact staging was performed.

## Integration fix round 3 — Important mutation and wrapper bypasses

This round started from `a193f96`. Scoped review identified three related
Important bypasses: time-output detection stopped at options belonging to a
preceding `env`/`nice` wrapper, clustered GNU `time` flags such as `-ao` were
not interpreted, and a parenthesized command group hid its executable body
from the classifier.

### RED evidence

Before changing production code, the new regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts __tests__/core/engine.test.ts __tests__/command-inspection.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Result: exit 1; **13 tests failed, 360 passed**. The failures covered
`env -u X /usr/bin/time -o`, `nice -n 5 /usr/bin/time -o`, clustered `-ao`
inspection and policy matching, parenthesized `/usr/bin/time` and `git add`
groups, and the corresponding engine no-file-creation cases.

### GREEN implementation and regressions

- `timeOutputOption` now walks the full leading wrapper chain using each
  wrapper's option/value grammar before resolving the wrapped command. This
  covers `env -u`, `nice -n`, absolute time paths, and output options after
  those wrappers.
- Shared command inspection recognizes argument-taking short options inside
  GNU-style clusters, so `time -ao timing.log curl ...` skips the output path
  and reaches the inner command for Claude/Codex policy matching.
- The destructive classifier recursively inspects quote-aware parenthesized
  groups while excluding arithmetic `(( ... ))` and quoted literal
  parentheses. Grouped `time -o`, `cp`, and `git add` commands now hard-stop.
- Safe `time -p`, format-only `-f/--format`, append-only options, and quoted
  literal parentheses remain non-mutating.

The focused mutation/engine/command-inspection/Claude/Codex policy suite passed
**373/373 tests**. `./node_modules/.bin/tsc --noEmit` passed and
`pnpm run build` succeeded. The full suite passed **779/779 tests**. Release
verification passed **9/9 tests**:

```text
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
```

The packed-install smoke checks passed with rebuilt artifacts and
`git diff --check` passed. No ledger edit, dependency change, version bump,
publish, push, merge, or release artifact staging was performed.

## Integration fix round 4 — Important shell-boundary bypasses

This round started from `207091ba7664b33badb0cafdff3192918865c861` after the
third integration-fix review. The new regressions covered clustered `env`
options and split-string payloads, non-parenthesized shell control syntax, and
commands hidden inside double-quoted substitutions.

### RED evidence

Before changing production code, the new focused regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/core/destructive.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Result: exit 1; **15 tests failed, 327 passed**. The failures reproduced the
three boundary classes: clustered `env -iu`/`-iS` consumption, `env`-wrapped
time output, brace/`if` clauses, and mutation commands inside double-quoted
`$()`/backtick substitutions. The shared seam assertion also showed that
split-string payloads were not recursively inspected.

### GREEN implementation and regressions

- `command-inspection.ts` now has a bounded shell-clause extraction seam that
  removes only quote-aware leading control words/braces (`{`, `if`, `then`,
  `case`, and related reserved words), preserving quoted literals. Wrapper
  inspection now supports command-string options and basename-qualified
  wrapper paths.
- `core/destructive.ts` parses GNU-style `env` short clusters, separate and
  attached `-u`/`-C`/`-S`, and long equivalents. `-S`/`--split-string` payloads
  recurse through the same mutation/time-output classifier. Substitution
  bodies are recursively classified with a finite depth budget, and grouped
  shell clauses are inspected before the safe-tier decision.
- Claude and Codex policy checkers include the same extracted shell clauses in
  their existing raw/stripped matching union; their precedence, wrapper
  semantics, and single-quoted literal behavior remain unchanged.
- Focused destructive/engine/command-inspection/policy verification passed
  **406/406 tests**. `./node_modules/.bin/tsc --noEmit` passed with no
  diagnostics.

The full suite passed **812/812 tests**. `pnpm run build` succeeded, and the
release/pack suites passed **9/9 tests**, including packed-install smoke checks.
`git diff --check` passed. No ledger edit, dependency change, dist staging,
version bump, publish, push, merge, or release artifact staging was performed.

### Self-review

The changes are limited to the shared pure inspection seam, the core mutation
classifier, the two policy consumers, and focused regressions. The new tests
cover mutating and read-only grouped clauses, recursive and single-quoted
substitutions, clustered/separate/long `env` forms, and no-execution engine
guards. Existing read-only compound, quoted-literal, wrapper, precedence, and
packed-install tests remain green. Recursive shell inspection is bounded and
falls back conservatively for over-depth syntax; no policy precedence or
mutation wrapper behavior outside the requested boundaries was changed.

## Integration fix round 5 — final shell-boundary/fail-closed integration

This final allowed integration round started from `6c1940de68ca2a052ee79cca2f302ff35e292b77`.
It addressed the remaining shell parsing and bounded-inspection findings. No
ledger edit, version bump, publish, push, merge, or release-artifact staging was
performed.

### RED evidence

Before production changes, the new public-seam regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/core/destructive.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Result: exit 1; **9 tests failed, 346 passed**. The failures reproduced
quote-insensitive `$()`/process-substitution extraction, absent completeness
signalling, missing `coproc`/case-branch extraction, silent mutation recursion
loss, Claude's quoted `time -f` value bypass, and the existing four-level
Claude/Codex policy traversal cutoff.

### GREEN implementation and fail-closed contract

- `command-inspection.ts` now uses a quote/escape-aware substitution lexer. It
  ignores parentheses inside single/double quotes and backticks, handles nested
  `$()` and process substitutions, and preserves the existing body-only
  `extractCommandSubstitutions` API. The explicit
  `inspectCommandSubstitutions` and `inspectCommandSubstitutionTree` seams report
  completeness and enforce depth, command-count, and character budgets.
- Core mutation classification now hard-stops with `complex shell syntax` for
  incomplete or over-budget executable substitutions. It recursively inspects
  every extracted body, case branch, named/unnamed coprocess body, and grouped
  clause before considering the safe tier. An un-decomposable case/coprocess
  construct cannot become SAFE.
- Claude and Codex policy checkers use the shared bounded substitution tree
  (32 levels, 512 inspected commands, and a 1 MiB aggregate character budget).
  Any incomplete/over-budget tree or control-clause inspection returns an
  actionable `incomplete shell syntax (policy inspection ...)` verdict instead
  of discarding pending bodies. Existing deny/prompt precedence and raw/stripped
  forms remain unchanged.
- Claude's raw wrapper stripper now tokenizes with quote-aware source spans and
  removes wrapper option arguments from the original string. Thus
  `time -f "%E %U" curl ...` reaches the inner command while preserving exact
  and glob rule spelling. Codex retains its argv-token behavior.
- `env` remains deliberately out of scope for host wrapper policy matching.
  The documented Claude/Codex wrapper vocabularies do not include `env`; this
  round does not invent policy semantics for it. Core mutation inspection still
  handles `env` as its own executable wrapper, including split-string payloads.

### GREEN verification

Focused destructive/engine/inspection/Claude/Codex verification:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/core/destructive.test.ts __tests__/core/engine.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Result: exit 0; **5 test files, 423 tests passed**. This includes engine
no-execution guards for quoted substitutions, case branches, and coprocesses,
read-only case false-positive coverage, deep denied `curl` policy coverage, and
over-budget fail-closed policy coverage.

Additional required checks:

```text
./node_modules/.bin/tsc --noEmit
pnpm run build
./node_modules/.bin/vitest run
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
git diff --check
```

All passed: typecheck/build succeeded; the full suite passed **829/829 tests**;
release/pack passed **9/9 tests**, including packed-install CLI/MCP smoke
checks; and `git diff --check` passed.

### Residual concerns

The shell inspection remains intentionally bounded and heuristic rather than a
full shell parser. The explicit contract is conservative at the boundary:
malformed quotes/substitutions, unsupported case/coprocess decomposition, and
budget exhaustion stop speculation. Policy inspection may therefore stop a
command that a full shell parser would prove harmless, which is preferable to
silently allowing an uninspected executable body. No new production dependency,
host wrapper vocabulary, or policy precedence rule was introduced.

## Extended integration fix round 6 — malformed case and recursive control clauses

This user-authorized extension started from `d4ab61e64ee8c2427eb045650249cb7901363679`.
It addresses the two remaining Important findings from the fifth review round:
malformed `case` branches were reported complete after dropping an unterminated
body, and Claude/Codex policy matching expanded only one control-clause level.
No ledger edit, version bump, publish, push, merge, or release-artifact staging
was performed.

### RED evidence

Before changing production code, the focused regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/core/destructive.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Result: exit 1; **23 tests failed, 362 passed**. The failures reproduced
first/middle/last malformed case branches, unmatched groups, and denied
commands nested in parenthesized, negated, conditional, case, and nested
control clauses for both policy adapters.

### GREEN implementation

- The shared command-inspection traversal now walks substitution bodies and
  executable control/group clauses recursively under depth, command-count, and
  character budgets. It tracks seen/queued bodies to avoid self-loop and
  duplicate expansion, and reports incomplete syntax before any pending body is
  silently discarded.
- Case extraction validates every branch's pattern/body delimiter and accepts
  `;;`, `;&`, and `;;&`; an unterminated or malformed branch is retained for
  diagnostics but marks the whole inspection incomplete. Quoted `esac` and
  terminator text remains literal. Arithmetic `(( ... ))` is excluded from
  executable-group extraction while substitutions inside it remain inspected.
- Claude and Codex consume the recursive shared tree directly, preserving their
  raw/stripped forms and existing deny/ask and most-restrictive precedence.
  Both adapters fail closed with actionable incomplete-shell results even when
  no restrictive rule is configured. Core mutation inspection uses the same
  structural preflight and remains fail closed on incomplete/over-budget
  executable syntax.

### GREEN verification

Focused security suites passed **385/385 tests**. The broader engine/policy
verification passed **254/254 tests**, and `./node_modules/.bin/tsc --noEmit`
passed with no diagnostics. The full suite passed **857/857 tests**.

```text
pnpm run build
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
git diff --check
```

Build succeeded; release/pack verification passed **9/9 tests**, including the
packed-install CLI/MCP smoke checks; and `git diff --check` passed.

### Self-review

The implementation is limited to the shared pure inspection seam, the core
mutation preflight, the Claude/Codex policy consumers, and focused regressions.
The bounded traversal is quote-aware, avoids arithmetic and quoted literals,
does not add wrapper vocabulary or alter host precedence, and preserves the
existing valid case/coprocess, substitution, read-only, and raw/stripped
matching tests. Malformed first/middle/last branches and unmatched executable
groups now fail closed instead of silently omitting bodies. Generated `dist/`
output remains ignored and unstaged; no runtime dependency, ledger, or release
metadata changed.

## Extended integration fix round 7 — terminal control clauses and complete case coverage

This user-authorized extension started from `5a415c352e00bdba6f5052a768d25f6d494c64d1`.
It addresses two remaining Important findings: terminal commands after
non-leading reserved words were not exposed to Claude/Codex policy matching,
and orphan text in a `case` body could be silently omitted while the parser
reported complete. No ledger edit, version bump, publish, push, merge, or
release-artifact staging was performed.

### RED evidence

Before production changes, the focused regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/core/destructive.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Result: exit 1; **17 tests failed, 388 passed**. The failures reproduced
missed `mkdir` commands after `then`/`do`/`else` in if/while/until/for,
substitution-wrapped and case-nested controls, and all three orphan-case
coverage positions.

### GREEN implementation

- The shared inspector now splits quote/escape-aware top-level command
  separators and control operators, repeatedly strips reserved prefixes, and
  emits only newly exposed terminal clauses. Ordinary commands are not
  re-queued, which keeps traversal bounded and prevents self-loops; case
  terminators remain attached to case constructs for structural validation.
- Case extraction now advances a cursor across every non-whitespace range,
  requiring each range to contain a pattern, branch body, and `;;`, `;&`, or
  `;;&` terminator. Orphan text before the first branch, between branches, or
  before `esac` marks the full inspection incomplete. Quoted delimiters,
  nested parentheses, empty bodies, alternation, and multiline branches stay
  valid.
- Core mutation inspection and both Claude/Codex policy adapters consume the
  shared bounded traversal; regressions cover if/elif/else, while/until,
  for/do, substitutions, nested groups, case branches, benign quoted words,
  and fail-closed malformed cases. Adapter-specific parsing and precedence
  were not changed.

### GREEN verification

Focused security suites passed **500/500 tests**:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/core/destructive.test.ts __tests__/core/engine.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Additional required checks all passed:

```text
./node_modules/.bin/tsc --noEmit
pnpm run build
./node_modules/.bin/vitest run
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
git diff --check
```

Typecheck/build succeeded; the full suite passed **906/906 tests**; and the
release/pack suite passed **9/9 tests**, including packed-install CLI/MCP smoke
checks. Generated `dist/` output remained ignored and unstaged.

### Self-review

The shared traversal retains source order in emitted clauses, preserves quoted
keywords and case delimiters, carries completeness through the existing depth,
command, and character budgets, and deduplicates without recursive mutation.
Case cursor coverage fails closed on executable/non-whitespace orphan ranges
while preserving valid branch forms. Changes are limited to the shared
inspection seam, core/policy regressions, and this report; no adapter re-parser,
policy precedence, wrapper vocabulary, runtime dependency, ledger, or release
metadata changed.

## Extended integration fix round 8 — function definitions, nested cases, and lexical traversal

This user-authorized extension started from `dce2fc83c5be8afd939b6b4a1a1eb23b58ef0cdb`.
It addresses the remaining Important findings that POSIX/Bash function bodies
were omitted from policy and mutation traversal, nested `case` delimiters could
close the wrong construct, compact `esac` was rejected, and executable-body
children were queued by extractor category rather than source order. No ledger
edit, version bump, publish, push, merge, or release-artifact staging was
performed.

### RED evidence

Before the production implementation, the new shared-inspection regressions
were run with:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts
```

Result: exit 1; **8 tests failed, 47 passed**. The failures reproduced omitted
function bodies (inline, newline, and `function name {}` forms), malformed
function definitions reported complete, nested function/substitution omission,
substitution-before-clause ordering, nested-case coverage loss, and compact
`case ... ;; esac` rejection. The new Claude/Codex policy and core mutation
regressions were then retained as the adapter/core behavior gates.

### GREEN implementation

- `command-inspection.ts` now recognizes quote-aware `name() { ... }` and
  documented `function name { ... }` definitions, including whitespace/newline
  variants. Bodies are recursively re-entered for nested functions, groups,
  substitutions, and clauses. Incomplete headers or unmatched bodies carry an
  explicit incomplete result so core and Claude/Codex fail closed; quoted
  function-like literals and ordinary command parentheses remain untouched.
- Nested case matching now counts inner `case`/`esac` pairs while finding the
  outer terminator, and reserved-word matching accepts compact `esac` while
  requiring identifier boundaries and ignoring quoted text. Branch terminators
  inside nested cases no longer corrupt outer coverage.
- The shared executable-body queue carries relative source offsets and uses a
  lexical priority queue. This preserves source order across substitutions,
  function bodies, groups, and control clauses while retaining the existing
  bounded command/depth/character budgets and policy precedence.
- Focused regressions cover mutating and benign nested branches, all supported
  function spellings, malformed definitions, nested substitutions, quoted
  literals, compact delimiters, and Claude/Codex deny traversal.

### GREEN verification

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/core/destructive.test.ts __tests__/core/engine.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Result: exit 0; **5 test files, 520 tests passed**.

Additional required checks all passed:

```text
./node_modules/.bin/tsc --noEmit
pnpm run build
./node_modules/.bin/vitest run
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
git diff --check
```

Typecheck/build succeeded; the full suite passed **926/926 tests**; release/pack
verification passed **9/9 tests**, including packed-install CLI/MCP smoke checks;
and `git diff --check` passed. Generated `dist/` output remained ignored and
unstaged.

### Self-review

The implementation is confined to the shared inspection seam and focused core,
Claude, and Codex regressions. Function extraction is quote/escape-aware,
supports nested brace depth, rejects malformed definitions, and does not treat
quoted literals or ordinary parentheses as definitions. Case parsing retains
the prior fail-closed orphan/unterminated behavior while adding nesting-aware
reserved delimiters. Lexical offsets are carried only inside the bounded shared
traversal, so host raw/stripped matching, verdict precedence, wrapper vocabulary,
and mutation classification remain unchanged. No runtime dependency, ledger,
release metadata, publish, push, merge, or version operation changed.

## Extended integration fix round 9 — exact spans, function headers in cases, and case suffixes

This user-authorized extension started from `16e9ed6d2647d5a69bf90ce16d7da95b8ef00a79`.
It closes three remaining shared-traversal completeness defects: duplicate
body text could be assigned the wrong source position by `lastIndexOf`, a
function header's `()` could be mistaken for case syntax, and commands after a
complete top-level `esac` were omitted. No ledger edit, version bump, publish,
push, merge, or release-artifact staging was performed.

### RED evidence

Before changing production code, the new regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts
```

Result: exit 1; **3 tests failed, 55 passed**. The failures reproduced
duplicate-body ordering, the nested-case `f(){ ... }` completeness failure,
and dropped commands after `esac`. The duplicate-body test was then sharpened
to place the group occurrence before the function occurrence, proving the
failure came from last-occurrence lookup rather than extractor ordering.

### GREEN implementation

- Shared clause, function, case-branch, group, and control-split extractors now
  carry exact source spans internally. The bounded tree sorts all executable
  events by their original offsets before deduplicating queued command text;
  no source offset is inferred with substring search. Existing depth, command,
  and character budgets remain unchanged.
- Case branch termination tracks function-header parentheses separately from
  case-pattern parentheses. POSIX and Bash `name()`, `name ()`, `function
  name`, and `function name()` definitions remain complete inside nested cases;
  alternation, quoted parentheses, and malformed cases preserve fail-closed
  behavior.
- The complete-case path emits every top-level suffix clause after `esac`,
  including multiple commands, control bodies, groups, and substitutions, in
  lexical order. Core mutation inspection and Claude/Codex policy checks use
  the shared tree regressions for nested-case functions and suffix commands.

### GREEN verification

Focused security suites passed **531/531 tests**:

```text
./node_modules/.bin/vitest run __tests__/command-inspection.test.ts __tests__/core/destructive.test.ts __tests__/core/engine.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts
```

Additional required checks all passed:

```text
./node_modules/.bin/tsc --noEmit
pnpm run build
./node_modules/.bin/vitest run
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
git diff --check
```

Typecheck/build succeeded; the full suite passed **937/937 tests**; release/pack
verification passed **9/9 tests**, including packed-install CLI/MCP smoke checks;
and `git diff --check` passed. Generated `dist/` output remained ignored and
unstaged.

### Self-review

The shared event queue now preserves first-in-source occurrence even when
function, group, and substitution bodies have identical text, while retaining
string-level deduplication and all traversal caps. Function-header recognition
is quote/escape-aware and scoped to a following brace, so case patterns and
malformed syntax still fail closed. Case suffixes are span-bearing events and
are recursively inspected by the same shared tree consumed by core, Claude,
and Codex. Changes are limited to `command-inspection.ts`, focused shared/core/
adapter regressions, and this report; policy precedence, mutation rules,
dependencies, ledger, and release metadata are unchanged.

## Extended integration fix round 11 — Ruby, Perl, and PHP writer coverage

This user-authorized extension starts from `5ffb131f9824f04b260e91452d96618507082511`.
It closes the remaining Important interpreter-scanner gaps while preserving the
prior policy, validation, traversal, and timing-output fixes. Ruby now covers
`File` `.`/`::` writer methods, the requested `FileUtils` writer namespace, and
all common write-capable `File.open` modes. Perl covers parenthesized and
bare-handle `open`, encoded output modes, read-write modes, pipes, `sysopen`
write flags, and common filesystem mutators. PHP coverage is case-insensitive
for all requested mutators and write-capable `fopen` modes. Static tests run for
all languages; this host has Ruby and Perl but no PHP executable, so PHP remains
static-only as intended.

### RED evidence

Before changing production code, the extended classifier table was run with:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts
```

Result: exit 1; **36 tests failed, 294 passed**. Failures reproduced the new
Ruby namespace/FileUtils/mode cases, Perl open/sysopen and mutator cases, PHP
case-insensitive API cases, and benign data/comment examples that motivated
the lexical masking contract.

### GREEN implementation and regressions

- `core/destructive.ts` now uses bounded language call scanners. They mask
  language string/comment data while preserving executable identifiers,
  capture balanced call arguments, and keep interpreter eval payload extraction
  separate from the shell's outer quoting.
- Ruby scanners recognize `File.write`/`binwrite`/delete/unlink/rename/truncate
  with either namespace separator; the full requested `FileUtils` writer set;
  and `File.open`/`File::open` modes including `rb+`, `r+`, and `w`/`a`/`x`
  variants.
- Perl scanners recognize bare and parenthesized `open` with output,
  append/read-write, encoding, and pipe modes; bare/parenthesized `sysopen`
  with `O_WRONLY`/`O_RDWR`/creation/truncation/append flags; and the common
  rename/unlink/truncate/mkdir/rmdir/chmod/chown/link/symlink mutators.
- PHP scanners match function names case-insensitively for all requested
  mutators and detect `fopen` modes `w`/`a`/`x`/`c`/`+`, including `rb+`.
  Generic word scanning masks writer words in language string/comment data,
  while the existing Node/Python writer scanner remains unchanged.
- Read-only counterexamples cover Ruby `File.read`/`File.open rb`, Perl
  `open '<'`/`sysopen O_RDONLY`, PHP `fopen r`/`file_get_contents`, plus writer
  words in quoted data/comments. Real temporary-directory engine probes run
  installed Ruby and Perl commands and confirm no create, delete, or modify
  operation executes after mutation hard-stop.

Focused core/policy/adapter verification:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts __tests__/core/engine.test.ts
```

Result: exit 0; **2 test files, 402 tests passed**.

```text
./node_modules/.bin/vitest run __tests__/core __tests__/policy.test.ts __tests__/opencode.test.ts __tests__/adapter-runtime.test.ts
```

Result: exit 0; **7 test files, 588 tests passed**. Typechecking passed with
`./node_modules/.bin/tsc --noEmit`, and `pnpm run build` succeeded.

Full and release verification:

```text
./node_modules/.bin/vitest run
```

Result: exit 0; **21 test files, 1,070 tests passed**.

```text
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
```

Result: exit 0; **2 test files, 9 tests passed**, including packed-install CLI
and MCP smoke checks. `git diff --check` passed. No ledger, release metadata,
dependency, dist, publish, push, merge, or version operation changed.

## Extended integration fix round 12 — interpreter scanner hardening

This user-authorized extension started from `3e05dfac085f998ae2d3f0aa55c6b86454e45c52`.
It closes the remaining Task 10 scanner gaps without changing the ledger,
release metadata, dependency set, publish/push/merge state, or version. Ruby
FileUtils now covers the documented direct mutating aliases (including
`rm_r`, `remove_entry`, `remove_entry_secure`, `rmtree`, `safe_unlink`,
`ln_sf`, recursive chmod/chown, copy/link/move/mkpath/remove aliases), while
query helpers remain read-only. Perl `sysopen` now evaluates only the
balanced, top-level third argument as its flags expression. Perl single-quoted
masking follows escaped quote/backslash semantics. PHP masking covers `#`,
`//`, and block comments, and PHP fallback scans use masked executable source;
leading-backslash, namespaced, and case-insensitive writers remain blocked.

### RED evidence

Before changing production code, the focused regression table was run with:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts
```

Result: exit 1; **25 tests failed, 341 passed**. Failures reproduced the
missing FileUtils aliases, flags found in Perl `sysopen` payload suffixes,
printed single-quoted Perl code, PHP `#`/block/string false positives, and
namespaced PHP writers. The first sysopen regression was then corrected to
keep `O_RDONLY` followed by printed/commented `O_TRUNC` safe while retaining
actual writer-flag cases.

### GREEN implementation and regressions

- `core/destructive.ts` expands the Ruby FileUtils vocabulary to the installed
  documented mutating aliases while preserving `pwd`, `uptodate?`, and
  comparison queries as benign. It adds a quote/comment-aware balanced parser
  for parenthesized and bare Perl `sysopen`; only its third top-level argument
  is checked for `O_WRONLY`, `O_RDWR`, `O_CREAT`, `O_TRUNC`, or `O_APPEND`.
- Language masking now handles Perl single-quoted escaped quotes and
  backslashes without swallowing following executable code. PHP call and
  fallback scans mask hash, slash, and block comments plus string contents.
  Shell eval payload extraction preserves backslashes that are literal inside
  double-quoted shell words, so PHP namespace separators and Perl escapes are
  retained for scanning.
- Focused static tests cover all requested aliases, read-only FileUtils
  queries, parenthesized/bare sysopen forms and flags, printed/commented
  writer text, PHP comment forms, and leading-backslash/namespaced/case-
  insensitive writers. Installed Ruby engine probes verify alias deletion and
  symlink creation are stopped before execution; an installed Perl probe
  executes an `O_RDONLY` sysopen with writer-looking printed/commented text and
  confirms the victim remains unchanged.

Focused verification:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts __tests__/core/engine.test.ts
```

Result: exit 0; **2 test files, 446 tests passed**. The implementation and
regressions were committed separately as `4b7b2cb` (`fix: harden interpreter
mutation scanners`).

### Required release verification

```text
./node_modules/.bin/tsc --noEmit
pnpm run build
./node_modules/.bin/vitest run
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
git diff --check
```

All commands passed. Typecheck/build succeeded; the full suite passed **21
files, 1,114 tests**; release/pack verification passed **2 files, 9 tests**,
including the real packed-install smoke checks; and `git diff --check` passed.
Generated `dist/` output remained ignored and unstaged.

### Self-review and scope/counts

The sysopen scanner is intentionally limited to the actual flags argument and
does not treat filenames, permissions, comments, strings, or later statements
as flags. Balanced parsing retains nested expressions and both call forms;
malformed/incomplete calls do not become a writer match through the new path.
Perl string masking remains offset-preserving, and PHP's executable scanner
uses the same masked source for direct and fallback checks. The Ruby list is
based on the installed FileUtils direct API and leaves query-only methods
untouched. Existing Node/Python fallback behavior, policy precedence, shell
traversal, and wrapper handling are unchanged. Working-tree changes at report
append time are limited to this report; no ledger, release metadata,
dependency, dist, publish, push, merge, or version operation changed.

At this round's final HEAD, the code commit is `4b7b2cb`; the report append is
kept as a separate documentation commit. Dynamic whole-branch diff counts
remain intentionally recomputable from the final merge-base, as in prior
rounds.

## Extended integration fix round 13 — bounded comment-aware interpreter arguments

This user-authorized extension started from `236c6cb34377d434b23d94c617114361927e198f`.
It closes the remaining interpreter-call scanner gaps around comments, newline
continuations, nested expressions, and actual mode-argument selection for Perl,
Ruby, and PHP. No ledger edit, version bump, publish, push, merge, or release
metadata change was performed.

### RED evidence

Before changing production code, the new round-13 regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts
```

Result: exit 1; **8 tests failed, 389 passed**. The failures reproduced
comment-hidden Perl `sysopen` flags and `open` modes, Ruby `File.open` modes,
and PHP `fopen` modes/comments.

### GREEN implementation and regressions

- `core/destructive.ts` now has one bounded language argument/call scanner that
  preserves literals, removes language comments, balances `()`/`[]`/`{}`, and
  returns parsed top-level fields. Calls over 64 KiB and malformed/ambiguous
  calls fail closed.
- Bare Perl calls continue across newline comments only while their argument
  list is incomplete; complete calls stop at the true statement boundary.
  `sysopen` inspects only its flags field, while Perl `open` inspects the actual
  mode field after comments and supports encoded, read-write, and pipe modes.
- Ruby `File.open`/`File::open` and PHP namespaced/case-insensitive `fopen`
  inspect the parsed second argument. PHP supports `//`, `#`, and block
  comments between the function name and `(` and within arguments. Nested
  argument expressions and multiple-statement false positives are covered.
- Interpreter eval payloads over the bound fail closed before recursive shell
  inspection, preventing oversized inputs from entering a quadratic path.

Real temporary-directory engine probes verify that read-only Perl, Ruby, and
available PHP forms leave the victim file unchanged and reach a leaf; static
writer coverage remains available when an interpreter is not installed.

Verification after the fix:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts __tests__/core/engine.test.ts
```

Result: exit 0; **2 files, 477 tests passed, 1 skipped**.

```text
./node_modules/.bin/tsc --noEmit
pnpm run build
./node_modules/.bin/vitest run
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
git diff --check
```

All checks passed. The full suite passed **1,145 tests with 1 skipped**; the
release/pack suites passed **9/9 tests** and built a real `predexec@0.4.0`
tarball with the rebuilt `dist/core/destructive.js`. The focused implementation
and test changes are committed separately from this report.

## Extended integration fix round 14 — static mode decoding and bounded language scans

This user-authorized extension starts from `f9dd973226b972be96f77c836d77be89859aa02a`.
It closes three remaining interpreter-scanner defects: encoded Ruby/Perl/PHP
writer modes were treated as raw text, generic `open(...)` fallback scanning
could mistake a filename/data string beginning with `w` or `a` for a writer
mode, and repeated nested language calls could drive reparsing toward a
quadratic path. No ledger, release metadata, dependency, version, publish,
push, or merge operation was performed.

### RED evidence

Before changing production code, the focused regression suite was run with:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts
```

Result: exit 1; **13 tests failed, 409 passed**. The failures reproduced Ruby,
Perl, and PHP hex-encoded writer modes; interpolation/variable and concatenated
mode expressions; Ruby/Perl/PHP filename/data false positives; and a nested
Ruby-call candidate budget regression.

### GREEN implementation and regressions

- Language mode arguments now return a typed `static`/`ambiguous` result.
  Double-quoted static values decode ordinary simple, hexadecimal, and octal
  escapes for Ruby, Perl, PHP, and Python mode parsing. Ruby interpolation and
  Perl/PHP variable interpolation are ambiguous and fail closed; concatenated,
  malformed, or non-quoted mode expressions also fail closed. Encoded read
  modes remain in the safe tier.
- Ruby, Perl, and PHP scanners inspect only their actual parsed mode argument.
  The generic eval fallback now scans masked executable identifiers and no
  longer contains a broad `open(...)` string-content regex. Python's built-in
  `open` keeps a dedicated parsed mode scanner, preserving existing writer
  coverage without reintroducing filename/data false positives.
- `findLanguageCalls` exports a deterministic
  `LANGUAGE_CALL_CANDIDATE_BUDGET` of 256. On the next candidate it returns a
  fail-closed sentinel before another balanced capture. Each capture and
  argument split retains the existing 64 KiB bound, so candidate work is
  bounded rather than allowing repeated nested calls to re-scan unbounded
  source. The regression builds exactly budget-plus-one nested Ruby calls and
  asserts a mutation stop; it does not rely on wall-clock timing.
- Real temporary-directory engine probes add encoded Ruby and Perl writer
  commands and confirm they stop before create/delete/modify execution. PHP
  remains statically covered because no PHP executable is installed on this
  host; its encoded writer, read, dynamic, and filename/data cases are in the
  classifier table.

### Verification and counts

Focused mutation and engine verification:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts __tests__/core/engine.test.ts
```

Result: exit 0; **2 files, 497 tests passed, 1 skipped** (the platform-conditional
interpreter probe skip).

Additional required checks:

```text
./node_modules/.bin/tsc --noEmit
pnpm run build
./node_modules/.bin/vitest run
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
git diff --check
```

All commands passed. The full suite passed **21 files, 1,165 tests with 1
skipped**; release/pack verification passed **9/9 tests**, including the real
packed-install CLI/MCP smoke checks; and the build regenerated ignored,
unstaged `dist/` output. The focused run completed in about one second and the
full suite in about five seconds as observational evidence only; the
budget-plus-one assertion is the deterministic performance bound.

### Self-review and scope

The decoder preserves single-quoted language semantics, ignores escaped
interpolation markers, rejects dynamic mode expressions, and recognizes only
complete quoted arguments. The fallback masking change leaves executable
writer identifiers visible for Node/Python APIs while hiding arbitrary string
and comment data. A budget sentinel is first in the result so direct-first and
iterating scanner consumers both fail closed. Existing read-mode, comment-aware
argument, Python writer, shell policy, and adapter behavior remain covered by
the full suite. Changes are limited to `core/destructive.ts`, focused
destructive/engine regressions, and this report. The code/test change is
committed as `905c5a8` (`fix: harden encoded interpreter modes and scan bounds`);
this report append remains a separate documentation commit. No ledger, release
metadata, dependency, dist, publish, push, merge, or version operation changed.

## Extended integration fix round 15 — executable interpolation and alternate literals

This user-authorized extension starts from `907ac63d4fc02f03ddb89cac134ee10ec6c711d4`.
It closes the generic-language-mask regression where executable interpolation
bodies were hidden along with literal strings. Node template `${...}`, Ruby
`#{...}` (including `%Q`), Python f-string braces (including prefixes and
triple strings), and Perl's executable `${\\ ...}`/`@{[ ... ]}` interpolation
forms now remain visible to the language-specific writer scanners. Ruby
`%q`, Perl `q{}`, anchored `=begin` blocks, heredoc/nowdoc bodies, Python
triple literals, and ordinary comments remain masked. Interpolation traversal
is bounded by explicit character/depth budgets and malformed or over-budget
source fails closed. No ledger, release metadata, dependency, version,
publish, push, merge, or release-artifact staging was performed.

### RED evidence

Before production changes, the focused regression run was:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts
```

Result: exit 1; **10 tests failed, 427 passed**. Failures reproduced writer
calls hidden inside Node/Ruby/Python interpolation, escaped/literal marker
false positives, writer-looking heredoc data, malformed interpolation, and
the nested interpolation budget case.

### GREEN implementation and regressions

- `core/destructive.ts` now builds an offset-preserving executable-language
  view for Node, Python, Ruby, Perl, and PHP. It recursively balances
  interpolation braces while respecting nested strings, escapes, comments,
  alternate literals, and heredoc terminators. `LANGUAGE_VIEW_CHARACTER_BUDGET`
  and `LANGUAGE_INTERPOLATION_DEPTH_BUDGET` bound traversal; existing
  `LANGUAGE_CALL_CANDIDATE_BUDGET` and mode-argument bounds remain intact.
- Node/Python/Ruby/Perl writer scanners consume the language-specific view;
  literal strings/comments are no longer generic fallback data, while actual
  executable interpolation bodies are scanned. PHP heredoc/comments are
  masked conservatively and static PHP writer coverage remains unchanged.
- Focused static regressions cover nested braces/quotes, escaped markers,
  `%q`/`q{}`, `=begin`, heredoc/nowdoc/triple-literal data, malformed source,
  and depth overflow. Installed Node/Python/Ruby/Perl engine probes confirm
  writer interpolations stop before create/delete/modify execution and benign
  escaped/literal forms reach a leaf without creating files. PHP remains
  static-only when no PHP interpreter is installed.

Verification:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts __tests__/core/engine.test.ts
```

Result: exit 0; **2 files, 521 tests passed, 1 skipped**.

```text
./node_modules/.bin/tsc --noEmit
pnpm run build
./node_modules/.bin/vitest run
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
git diff --check
```

All checks passed: typecheck/build succeeded; the full suite passed **21
files, 1,189 tests with 1 skipped**; release/pack verification passed **9/9
tests**; and `git diff --check` passed. Generated `dist/` remains ignored and
unstaged.

### Self-review and scope/counts

The executable view preserves source offsets for balanced call extraction,
restores only code reached through executable interpolation, and masks nested
literal strings. Escapes and doubled Python f-string braces cannot open an
interpolation. Perl's alternate literals preserve only constructs documented
to execute code. Incomplete heredocs, unterminated strings/interpolations,
depth overflow, and character overflow return the fail-closed eval marker.
Mode parsing from round 14 remains unchanged. Changes are limited to
`core/destructive.ts`, focused destructive/engine regressions, and this report;
no dependency, ledger, release metadata, publish, push, merge, version, or
dist staging changed.

## Extended integration fix round 16 — interpreter shell bodies, heredocs, POD, and traversal bounds

This user-authorized extension starts from `881c40f0f1d793bc87b16156faae3b1c59dccef1` and is implemented in code commit `e0608ba` (`fix: classify interpreter shell bodies safely`). It closes the remaining critical language-view gaps without changing the ledger, release metadata, dependency set, version, publish/push/merge state, or release-artifact staging.

### RED evidence

Before production changes, the new focused regressions were run with:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts __tests__/core/engine.test.ts
```

Result: exit 1; **16 tests failed, 535 passed, 1 skipped**. Failures reproduced Perl `qx{}`/`qx()`/backtick shell writers and redirections, Ruby/PHP backticks, incomplete delimiters, quoted/indented Ruby heredoc masking, nested `%q`, Perl POD, and the large nested Ruby traversal case. The real temporary-directory probe confirmed the interpreter shell writer commands reached a leaf before the fix.

### GREEN implementation

- `core/destructive.ts` extracts bounded Perl `qx{...}`, `qx(...)`, and Perl/Ruby/PHP backtick bodies from the executable language view. Each complete body is recursively passed through the core shell mutation classifier, so redirects, `rm`, `cp`, Git mutations, timing-file options, substitutions, and shell control syntax remain visible. Escaped delimiters, shell quoting, nesting, malformed bodies, and over-budget views fail closed; qx is not treated as inert literal data.
- Ruby heredocs now distinguish single-quoted and backslash-quoted delimiters from unquoted/double-quoted forms. `<<-` and `<<~` terminators with indentation are recognized, escaped `\\#{...}` markers remain literal, and executable interpolation bodies are re-entered by the same language view. Nested Ruby `%q` bodies are fully masked while `%Q` interpolation recursively remains executable.
- Perl POD beginning at a line-boundary `=pod` or `=headN` is masked through a line-boundary `=cut`, while code after `=cut` remains visible.
- Language-view traversal charges masking and recursive work against a deterministic budget and caps language-view character input at 32 KiB. Interpreter eval commands above a 24 KiB early limit fail closed before the quadratic shared shell preflight; the round-16 regression uses a 30K+ nested Ruby payload and completes without timing assertions.

### GREEN verification and probes

Focused mutation and engine verification:

```text
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts __tests__/core/engine.test.ts
```

Result: exit 0; **2 files, 553 tests passed, 1 skipped**. Real temporary-directory probes on installed Perl/Ruby verify qx/backtick `rm` and redirect bodies stop before creating/deleting files; read-only qx/backtick bodies reach a leaf.

Required release checks:

```text
./node_modules/.bin/tsc --noEmit
pnpm run build
./node_modules/.bin/vitest run
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
git diff --check
```

All commands passed. The full suite passed **21 files, 1,223 tests with 1 skipped**; release/pack verification passed **9/9 tests**, including packed-install CLI/MCP smoke checks; and `git diff --check` passed. Generated `dist/` output remained ignored and unstaged.

### Self-review, scope, and performance bound

The shell-body parser is quote-aware and delimiter-bounded, preserves recursive shell classification through the existing depth/substitution guards, and returns an actionable eval-payload hard stop for incomplete language constructs. The language view's optional shell-body collection is only consumed by interpreter eval classification; existing Node/Python behavior and adapter policy precedence remain unchanged. Heredoc and POD masking is offset-preserving, and nested interpolation routes through the same parser rather than inserting raw text. The 30K+ nested `%Q` payload is a deterministic non-timing regression for the early 24 KiB interpreter-eval bound; no expensive shared shell-tree traversal runs for that input.

Changes are limited to `core/destructive.ts`, focused destructive/engine regressions, and this report. No ledger, release metadata, dependency, version, dist, publish, push, merge, or harness operation changed.
