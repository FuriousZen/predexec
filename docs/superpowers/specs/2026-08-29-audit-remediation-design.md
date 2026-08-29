# Predexec Audit Remediation Design

## Purpose

Remediate every actionable concern from the August 2026 general-purpose audit while preserving predexec's defining behavior: deterministic, read-only speculative execution across pi, opencode, Claude Code, and Codex.

The work is ordered by reward relative to regression risk. First fix invariant violations and directly reproducible accuracy defects. Then impose resource bounds and harden fallback paths. Only after behavior is protected by tests should shared policy mechanics and model-facing plan descriptions be consolidated.

## Binding constraints

- Node.js remains `>=22`.
- `core/` remains pure TypeScript with zero harness imports and zero third-party runtime dependencies.
- No new production dependency is introduced.
- Mutating nodes continue to hard-stop before execution; mutation execution remains out of scope.
- Existing harness-specific policy precedence remains unchanged: opencode is last-match-wins, while Codex is most-restrictive-wins.
- Existing packed-install, real-ESM, stdio-protocol, and policy fail-closed guarantees remain intact.
- Every behavior change follows red-green-refactor TDD and receives a task-scoped review.
- Adapter-visible text changes only when needed to make truncation, containment, or validation behavior truthful.

## Approach considered

### Selected: staged invariant-first remediation

Implement narrow, independently testable vertical changes in risk-adjusted order. Lock each behavior with regression tests, then perform consolidation against those tests. This has the smallest blast radius and keeps every commit useful on its own.

### Rejected: architecture-first rewrite

Normalize output, policy, plan-schema, and adapter interfaces before fixing defects. This would produce cleaner intermediate types but would combine too many behavior changes into one review surface and make regressions hard to attribute.

### Rejected: local patches only

Patch each symptom in place without improving seams. This is initially faster, but it leaves policy and plan-language knowledge duplicated and makes the next adapter-specific fix likely to drift.

## Design

### 1. Completeness-aware node output

`NodeOutput` gains `stdoutTruncated` and `stderrTruncated` booleans. Every shell and tool-operation execution path sets them when any bytes or characters are omitted. Aggregation propagates them, and transcript rendering uses the flags rather than searching for marker text.

The displayed output retains the current explicit truncation marker. Shell capture must mark truncation even when the retained prefix is exactly `OUTPUT_CAP` characters and later chunks are dropped.

Condition behavior becomes conservative when the relevant stream is incomplete:

- A positive `match` may still succeed when its regex is observed in the retained prefix.
- A negated `match` on a truncated stream always evaluates false with a detail explaining that absence cannot be established.
- `numeric` evaluates false on truncated stdout because a later or partially truncated value could change the result.
- `jsonPath` already fails on truncated JSON; it will explicitly report incomplete stdout rather than reporting generic invalid JSON.
- `exitCode`, `fileExists`, and `always` remain unaffected.

This represents completeness as data instead of relying on prose markers that the evaluator cannot safely interpret.

### 2. Conservative command mutation classification

Ordinary `cp source destination` is mutating. Git classification becomes allowlist-oriented for the verb position: only established read-only verbs and their existing read-only subforms pass. Mutating verbs including `add`, `clone`, `fetch`, `pull`, and `init` hard-stop.

The classifier remains a defense-in-depth heuristic rather than a shell parser or sandbox. Existing false-positive carve-outs for quoted search patterns, comparisons, and pure-reader heads remain. A table-driven regression suite will contain both allowed and blocked commands so new coverage cannot silently make common inspection commands unusable.

### 3. One effective working-directory rule

`PlanTree.cwd` is a relative directory beneath the session root. Absolute paths, `..` escapes, and values resolving outside the session root are validation errors before any command or tool operation runs. Symlink resolution is handled separately by tool-operation target containment; working-directory validation is lexical so ordinary worktree and package-manager paths remain usable.

The engine computes the effective directory once. Shell commands, `fileExists`, and every adapter tool executor receive that exact directory. Pi must stop constructing permanently root-bound native tools; it creates or caches native tool adapters by effective directory.

### 4. Explicit execution resource budgets

Plans may contain at most 64 operations per node. A larger node is rejected during plan validation with an authoring error.

`parallel:true` executes at most 8 operations concurrently while preserving result order. Sequential nodes retain stop-on-first-error behavior. Parallel nodes retain run-all behavior and aggregate the first failing result in plan order.

Pi's live progress buffer retains at most `OUTPUT_CAP` characters plus one truncation marker. It does not accumulate output when `onUpdate` is absent. Progress truncation does not alter the final engine transcript.

### 5. Accurate statistics and unambiguous JSON conditions

Visited-operation counting follows `pathTaken` occurrence by occurrence. A repeated node in a legal cycle contributes its operations on every visit.

`jsonPath` conditions are permitted only on nodes containing exactly one operation. A multi-operation node labels aggregated stdout by operation index, so it cannot promise a single JSON document. `coercePlan`/plan validation returns an actionable authoring error telling the model to split the JSON-producing command into its own node. The model-facing plan description states this rule.

### 6. Bounded and termination-safe MCP fallback tools

The pure-Node grep fallback applies the same `isSafeRegex` screen used by condition evaluation before constructing a JavaScript `RegExp`. Unsafe patterns fail with search-error exit code 2 and an actionable explanation.

MCP `read` processes large text incrementally and retains only the requested line slice while still counting total lines for its continuation notice. It preserves binary refusal, one-based offsets, final-newline behavior, and existing output text.

Fallback grep receives the requested match limit. Candidate files are sorted deterministically, scanned in path and line order, and scanning stops after `limit + 1` matches, which is enough to return the requested results and truthfully emit the existing limit warning. File contents are processed incrementally; context rendering retains only data for returned matches. The 20,000-file walk ceiling remains.

### 7. Operation-wide policy and truthful symlink containment

The engine policy seam accepts a normalized `Operation`, not only a shell string. Every operation crosses the seam before execution.

- Shell strings and `{tool:"bash"}` continue through existing Bash policy logic.
- Claude settings-file rules for `Read`, `Grep`, and `Glob` are applied to corresponding `read`, `grep`, `find`, and `ls` operations when expressible.
- opencode static permission entries for read/search/list operations are applied where the configuration provides them.
- Codex has no persisted file-operation policy equivalent; its adapter reports no host rule rather than pretending an execpolicy rule covers reads.
- Pi continues to rely on its native tool adapters where no separate persisted policy source exists.
- Any unreadable policy source that is supposed to govern an operation fails closed, matching existing shell behavior.

MCP explicit targets are checked by real path after existence is established. A symlink resolving outside the session root is rejected unless its lexical path contains a `node_modules` segment; dependency-manager symlink farms remain usable, and the model-facing description explicitly names this exception. Symlinked directories remain non-recursive unless the operation already follows them.

### 8. Consolidation after behavior is stable

Create a harness-neutral command-inspection module containing only mechanics proven identical by parity tests: command-substitution extraction, shell-word tokenization, leading assignment removal, and wrapper normalization. Host policy parsing, precedence, matching, and verdict selection remain in separate adapters.

Create one adapter-neutral plan-language description source for condition names, tool-operation shapes, the single-operation `jsonPath` rule, cwd containment, and resource ceilings. MCP and opencode compose their prose from it. Pi keeps its host-specific schema projection, with parity tests asserting that canonical field names and limits are represented. Intentional Pi wording differences remain.

## Task ordering

1. Completeness-aware output and conditions.
2. Mutation-classifier bypasses.
3. Effective working-directory consistency.
4. Execution and progress budgets.
5. Statistics and `jsonPath` accuracy.
6. MCP fallback termination and memory bounds.
7. Operation-wide policy and symlink containment.
8. Command-inspection and plan-language consolidation.
9. Cross-adapter release verification and final review.

This order fixes the most damaging false-hit and mutation risks first, places low-coupling correctness fixes before large adapter changes, and postpones refactoring until behavior is pinned.

## Testing strategy

Each implementation task begins with a focused failing regression test and records the expected failure before production changes. Tests exercise public behavior wherever practical:

- runner and engine integration tests for output completeness, concurrency, cwd, and validation;
- table-driven destructive-command tests for allowed and blocked commands;
- real adapter tests for Pi effective cwd and bounded progress;
- condition and stats tests for truncation, cycles, and `jsonPath` authoring errors;
- real temporary files, symlinks, and pure-Node MCP fallbacks for filesystem behavior;
- policy fixtures for every supported host rule shape;
- parity tests for extracted command inspection and plan-language projections;
- full Vitest suite, TypeScript typecheck, build, packed-install tests, and release-hygiene tests at the end.

## Error handling and compatibility

New validation failures return existing `stoppedReason:"error"` adapter results with actionable text. Resource and containment limits fail before an operation begins. Search failures retain the MCP convention that exit code 1 means a completed search with no result and exit code 2 means the search did not complete.

No persisted data schema changes except corrected `ops` and `requestsSaved` values for future cyclic runs. Existing stats records remain readable. No public package entry point or tool name changes.

## Non-goals

- A complete shell parser or OS sandbox.
- Mutation execution, dry-run mutation, or `terminate:true` behavior.
- Merging host policy adapters or changing their precedence rules.
- Following symlinked directories during recursive searches.
- Adding a new runtime dependency.
- Making all adapter descriptions byte-identical.

## Completion criteria

- Every audit concern has a completed implementation task or an explicit, reviewed compatibility ruling.
- Each new regression test was observed failing before its implementation.
- All task-scoped reviews approve both spec compliance and code quality.
- Full tests, typecheck, build, packed-install verification, and final whole-branch review pass.
- Tracked source changes are committed locally; nothing is pushed, published, or merged automatically.
