# Predexec Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct predexec's audited safety, accuracy, and resource-bound defects, then simplify the affected policy and plan-language modules without weakening harness-specific behavior.

**Architecture:** Implement narrow, independently reviewed vertical changes in risk-adjusted order. Represent output completeness and operation policy as explicit core data, enforce one cwd and resource-budget contract, harden MCP fallbacks, then consolidate only mechanics proven identical by tests.

**Tech Stack:** Node.js 22+, TypeScript 5.9, Vitest 4, pnpm 11, `@modelcontextprotocol/server` v2, zod 4.

**Spec:** `docs/superpowers/specs/2026-08-29-audit-remediation-design.md`

## Global Constraints

- `core/` stays pure TypeScript with zero harness imports and zero third-party runtime dependencies.
- Add no production dependency.
- Mutating nodes hard-stop before execution; mutation execution remains out of scope.
- Preserve opencode last-match-wins and Codex most-restrictive-wins policy semantics.
- Preserve packed-install, ESM, stdio-protocol, and fail-closed policy behavior.
- Every production behavior change starts with a focused failing test whose expected failure is observed.
- Use `./node_modules/.bin/vitest run <test files>` for focused tests and `./node_modules/.bin/tsc --noEmit` for typechecking.
- Run the full 621-test-or-greater suite, build, and packed-artifact verification before completion.
- Do not stage or modify `PLAN.post-0.3.1-archive.md` or `CODEX-RESEARCH.md`; they are pre-existing user-owned untracked files.
- Use explicit `git add` paths; never `git add -A`.

---

### Task 1: Make output completeness structural

**Files:**
- Modify: `core/types.ts`
- Modify: `core/runner.ts`
- Modify: `core/conditions.ts`
- Modify: `core/engine.ts`
- Modify: `__tests__/core/runner.test.ts`
- Modify: `__tests__/core/conditions.test.ts`
- Modify: `__tests__/core/engine.test.ts`

**Interfaces:**
- Produces: `NodeOutput.stdoutTruncated: boolean` and `NodeOutput.stderrTruncated: boolean`.
- Produces: completeness-aware `evaluateConditionWithDetail` behavior.
- Preserves: `OUTPUT_CAP = 8192` and the visible `TRUNCATION_MARKER` prefix.

- [ ] **Step 1: Add failing shell-capture and transcript tests**

Add to `__tests__/core/runner.test.ts`:

```ts
it("marks truncation when a later chunk arrives after an exact OUTPUT_CAP prefix", async () => {
  const q = String.fromCharCode(39);
  const script = 'process.stdout.write("x".repeat(8192)); setTimeout(() => process.stdout.write("TAIL"), 30)';
  const r = await runNode({ id: "n", commands: [`node -e ${q}${script}${q}`] }, { cwd });
  expect(r.stdout).toContain("…[truncated");
  expect(r.stdout).not.toContain("TAIL");
  expect(r.stdoutTruncated).toBe(true);
  expect(r.stderrTruncated).toBe(false);
});
```

Add a tool-executor case returning `"x".repeat(OUTPUT_CAP + 1)` and assert the same boolean/marker contract. Add an engine test asserting the transcript warning is driven by `stdoutTruncated`, not by marker substring detection.

- [ ] **Step 2: Run the focused runner/engine tests and verify RED**

Run:

```bash
./node_modules/.bin/vitest run __tests__/core/runner.test.ts __tests__/core/engine.test.ts
```

Expected: FAIL because `NodeOutput` has no completeness fields and exact-cap shell capture omits the marker.

- [ ] **Step 3: Add failing completeness-aware condition tests**

Add to `__tests__/core/conditions.test.ts` using an output helper that defaults both flags to false:

```ts
it("does not establish absence or a number from truncated output", () => {
  const incomplete = {
    stdout: "all good\n…[truncated]",
    stderr: "",
    exitCode: 0,
    stdoutTruncated: true,
    stderrTruncated: false,
  };
  expect(evaluateConditionWithDetail(
    incomplete,
    { kind: "match", source: "stdout", regex: "ERROR", negate: true },
    "/",
  )).toMatchObject({ result: false });
  expect(evaluateConditionWithDetail(
    incomplete,
    { kind: "numeric", source: "stdout", extract: "(\\d+)", op: "eq", value: 0 },
    "/",
  )).toMatchObject({ result: false });
});

it("allows a positive match observed before truncation", () => {
  const incomplete = {
    stdout: "READY\n…[truncated]",
    stderr: "",
    exitCode: 0,
    stdoutTruncated: true,
    stderrTruncated: false,
  };
  expect(evaluateConditionWithDetail(
    incomplete,
    { kind: "match", source: "stdout", regex: "READY" },
    "/",
  ).result).toBe(true);
});
```

Also assert `jsonPath` reports `stdout was truncated` rather than generic invalid JSON.

- [ ] **Step 4: Run condition tests and verify RED**

Run:

```bash
./node_modules/.bin/vitest run __tests__/core/conditions.test.ts
```

Expected: FAIL because conditions ignore completeness.

- [ ] **Step 5: Implement completeness propagation**

Change `NodeOutput` in `core/types.ts` to:

```ts
export interface NodeOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}
```

Give `CommandResult` the same booleans. In `runShell`, track raw receipt independently from retained length:

```ts
let stdoutTruncated = false;
let stderrTruncated = false;

child.stdout?.on("data", (d: Buffer) => {
  const s = d.toString();
  const remaining = OUTPUT_CAP - stdout.length;
  if (remaining > 0) stdout += s.slice(0, remaining);
  if (s.length > remaining) stdoutTruncated = true;
  opts.onCommandOutput?.(s);
});
```

Apply the symmetric stderr logic. At `finish`, append one explicit marker when the corresponding flag is true. For tool operations, set flags before slicing. Refactor aggregation so it ORs per-command flags and never infers completeness by searching text.

In `conditions.ts`, determine the selected stream's flag. Return false with explicit detail for negated matches on incomplete streams, all numeric conditions on incomplete stdout, and all JSON-path conditions on incomplete stdout. Positive matches continue evaluating the retained prefix.

In `engine.ts`, render the continuation warning when either flag is true.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
./node_modules/.bin/vitest run __tests__/core/runner.test.ts __tests__/core/conditions.test.ts __tests__/core/engine.test.ts
./node_modules/.bin/tsc --noEmit
```

Expected: all pass.

Commit:

```bash
git add core/types.ts core/runner.ts core/conditions.ts core/engine.ts __tests__/core/runner.test.ts __tests__/core/conditions.test.ts __tests__/core/engine.test.ts
git commit -m "fix: make output completeness explicit"
```

---

### Task 2: Close obvious mutation-classifier bypasses

**Files:**
- Modify: `core/destructive.ts`
- Modify: `__tests__/core/destructive.test.ts`
- Modify: `__tests__/core/engine.test.ts`

**Interfaces:**
- Consumes: `findDestructiveToken(command)` and mutation hard-stop behavior.
- Produces: conservative classification for ordinary `cp` and Git verb invocations.

- [ ] **Step 1: Add failing table-driven classifier tests**

Add blocked cases:

```ts
it.each([
  "cp source.txt destination.txt",
  "cp -- source.txt destination.txt",
  "git add file.txt",
  "git clone https://example.invalid/repo target",
  "git fetch origin",
  "git pull --ff-only",
  "git init scratch",
])("blocks mutating command: %s", (command) => {
  expect(findDestructiveToken(command)).not.toBeNull();
});
```

Add allowed cases:

```ts
it.each([
  "git status --short",
  "git diff --stat",
  "git log -5 --oneline",
  "git show HEAD:README.md",
  "git rev-parse --show-toplevel",
  "git branch --list",
  "git tag --list",
  "git remote -v",
  "git config --get user.name",
])("allows read-only git command: %s", (command) => {
  expect(findDestructiveToken(command)).toBeNull();
});
```

Add one engine regression proving `cp source destination` stops before `runNode` creates the destination.

- [ ] **Step 2: Verify RED**

Run:

```bash
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts __tests__/core/engine.test.ts
```

Expected: FAIL for ordinary `cp` and omitted Git verbs.

- [ ] **Step 3: Implement conservative Git verb inspection**

Replace the `cp\s+-` branch with `\bcp\b`. Add a Git verb scanner before the generic word scan:

```ts
const READ_ONLY_GIT_VERBS = new Set([
  "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree",
  "grep", "blame", "describe", "shortlog", "name-rev", "for-each-ref",
]);
```

Continue honoring the existing explicitly read-only subforms of `branch`, `tag`, `stash`, `config`, and `remote`. Skip documented global options and their values before locating the verb. If a segment's effective head is `git` and its verb is absent from the read-only set/subforms, return `git <verb>` as the destructive token. Do not merge this with host policy matching.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
./node_modules/.bin/vitest run __tests__/core/destructive.test.ts __tests__/core/engine.test.ts
./node_modules/.bin/tsc --noEmit
```

Commit:

```bash
git add core/destructive.ts __tests__/core/destructive.test.ts __tests__/core/engine.test.ts
git commit -m "fix: close copy and git mutation bypasses"
```

---

### Task 3: Enforce one effective working directory

**Files:**
- Modify: `core/engine.ts`
- Modify: `core/types.ts`
- Modify: `.pi/extension/index.ts`
- Modify: `__tests__/core/engine.test.ts`
- Modify: `__tests__/pi.test.ts`
- Modify: `__tests__/mcp/tool-ops.test.ts`

**Interfaces:**
- Produces: `resolvePlanCwd(sessionRoot: string, planCwd?: string): { cwd: string } | { error: string }` exported from `core/engine.ts` for focused tests.
- Preserves: tool executors receive the engine-computed `RunOptions.cwd`.

- [ ] **Step 1: Add failing central validation tests**

Add engine cases asserting no command runs for `cwd: "/tmp"`, `cwd: ".."`, and non-string cwd. Assert `stoppedReason === "error"` and transcript contains `cwd must be a relative directory inside the session root`.

Add a positive nested-directory test using a temporary `sub/` directory.

- [ ] **Step 2: Add a failing Pi effective-cwd test**

Extend the Pi tool-factory mock so it records the cwd passed to `createReadTool`. Execute a plan with `cwd: "sub"` and `{tool:"read", path:"inside.txt"}`. Assert the factory receives the resolved `sub` directory rather than the session root.

- [ ] **Step 3: Verify RED**

Run:

```bash
./node_modules/.bin/vitest run __tests__/core/engine.test.ts __tests__/pi.test.ts
```

Expected: absolute/escaping shell cwd runs today, and Pi remains root-bound.

- [ ] **Step 4: Implement central cwd resolution**

Use `isAbsolute`, `relative`, and `resolve`:

```ts
export function resolvePlanCwd(sessionRoot: string, planCwd?: string): { cwd: string } | { error: string } {
  if (planCwd === undefined) return { cwd: sessionRoot };
  if (typeof planCwd !== "string" || planCwd === "" || isAbsolute(planCwd)) {
    return { error: "cwd must be a relative directory inside the session root" };
  }
  const cwd = resolve(sessionRoot, planCwd);
  const rel = relative(sessionRoot, cwd);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { error: "cwd must be a relative directory inside the session root" };
  }
  return { cwd };
}
```

Call this after structural plan validation and before `runNode`. Return an error `CoreResult` before execution on failure.

In Pi, replace one fixed tool map with a `Map<string, tool-map>` keyed by `opts.cwd`; construct native tools for the effective cwd on first use. Preserve the incoming abort signal.

- [ ] **Step 5: Verify GREEN, retain MCP defense, and commit**

Run:

```bash
./node_modules/.bin/vitest run __tests__/core/engine.test.ts __tests__/pi.test.ts __tests__/mcp/tool-ops.test.ts
./node_modules/.bin/tsc --noEmit
```

Commit:

```bash
git add core/engine.ts core/types.ts .pi/extension/index.ts __tests__/core/engine.test.ts __tests__/pi.test.ts __tests__/mcp/tool-ops.test.ts
git commit -m "fix: enforce one contained plan cwd"
```

---

### Task 4: Bound parallel execution and Pi progress memory

**Files:**
- Modify: `core/types.ts`
- Modify: `core/engine.ts`
- Modify: `core/runner.ts`
- Modify: `.pi/extension/index.ts`
- Modify: `__tests__/core/engine.test.ts`
- Modify: `__tests__/core/runner.test.ts`
- Modify: `__tests__/pi.test.ts`

**Interfaces:**
- Produces: `MAX_OPERATIONS_PER_NODE = 64` and `MAX_PARALLEL_CONCURRENCY = 8` from `core/types.ts`.
- Produces: `appendProgressText(current: string, data: string): string` from the Pi adapter for direct testing.

- [ ] **Step 1: Add failing plan-size and concurrency tests**

Add an engine validation test with 65 `true` commands expecting an error naming the 64-operation ceiling.

Add a runner test whose tool executor increments an active counter, waits on a short timer, and records the maximum. Execute 24 operations with `parallel:true`; expect `maxActive <= 8`, all 24 results present, and result order equal to command order.

- [ ] **Step 2: Add failing Pi progress-buffer tests**

Export and test this contract:

```ts
expect(appendProgressText("", "x".repeat(100_000)).length).toBeLessThanOrEqual(OUTPUT_CAP + 64);
expect(appendProgressText("", "x".repeat(100_000))).toContain("…[truncated");
```

In the adapter integration test, omit `onUpdate`, stream a large command result, and assert no progress accumulator helper is invoked.

- [ ] **Step 3: Verify RED**

Run:

```bash
./node_modules/.bin/vitest run __tests__/core/runner.test.ts __tests__/core/engine.test.ts __tests__/pi.test.ts
```

- [ ] **Step 4: Implement validation, worker pool, and bounded progress**

Export exact constants:

```ts
export const MAX_OPERATIONS_PER_NODE = 64;
export const MAX_PARALLEL_CONCURRENCY = 8;
```

Reject oversized nodes in `validatePlan`. Replace `Promise.all(commands.map(...))` with indexed workers:

```ts
const results = new Array<CommandResult>(commands.length);
let next = 0;
async function worker(): Promise<void> {
  while (next < commands.length) {
    const index = next++;
    results[index] = await runOneOp(commands[index]!, opts);
  }
}
await Promise.all(Array.from(
  { length: Math.min(MAX_PARALLEL_CONCURRENCY, commands.length) },
  () => worker(),
));
return results;
```

In Pi, import `OUTPUT_CAP` from the owning core module or export it through the public core interface. `appendProgressText` retains the prefix up to `OUTPUT_CAP` and appends one marker. Only pass `onCommandOutput` when `onUpdate` exists.

- [ ] **Step 5: Verify GREEN and commit**

Run focused tests plus typecheck, then commit:

```bash
git add core/types.ts core/engine.ts core/runner.ts core/index.ts .pi/extension/index.ts __tests__/core/engine.test.ts __tests__/core/runner.test.ts __tests__/pi.test.ts
git commit -m "fix: bound plan parallelism and progress output"
```

---

### Task 5: Correct cycle stats and JSON-path authoring

**Files:**
- Modify: `stats.ts`
- Modify: `core/engine.ts`
- Modify: `steering.ts`
- Modify: `.pi/extension/index.ts`
- Modify: `mcp/server.ts`
- Modify: `.opencode/plugins/predexec.ts`
- Modify: `__tests__/stats.test.ts`
- Modify: `__tests__/core/engine.test.ts`
- Modify: `__tests__/index.test.ts`

**Interfaces:**
- Produces: repeated-path operation counting.
- Produces: validation rule that a node with a `jsonPath` edge has exactly one operation.
- Produces: model-facing sentence `jsonPath edges require a one-operation source node.`

- [ ] **Step 1: Add failing cycle-stat test**

```ts
it("counts operations on every visit through a legal cycle", () => {
  const p = plan([{ id: "a", commands: ["c1", "c2"] }]);
  const r = result({ pathTaken: ["a", "a", "a"], depthReached: 2 });
  expect(estimateRequestsSaved(p, r)).toBe(5);
});
```

- [ ] **Step 2: Add failing JSON-path validation test**

Create a node with `commands: ["true", "printf '{\"ok\":true}'"]` and a `jsonPath` edge. Assert `validatePlan` returns `jsonPath edges require a one-operation source node` and `runPlanTree` executes no command.

Add a one-command JSON node case that remains valid.

- [ ] **Step 3: Verify RED**

Run stats and engine tests. Expected: cycle test reports 1 rather than 5; multi-command JSON plan validates.

- [ ] **Step 4: Implement occurrence-based counting and validation**

Build `Map<NodeId, PlanNode>` once in `countVisitedOps`, then reduce `result.pathTaken`:

```ts
return result.pathTaken.reduce((ops, id) => ops + (byId.get(id)?.commands.length ?? 0), 0);
```

During the engine's edge validation, reject a node with `commands.length !== 1` when any outgoing edge has `when.kind === "jsonPath"`.

Add `JSON_PATH_SINGLE_OP_LINE` to `steering.ts` and compose it into all three adapter plan descriptions/schema descriptions. Task 9 will consolidate the remaining shape prose; do not redesign schemas here.

- [ ] **Step 5: Verify GREEN and commit**

Run focused tests and typecheck. Commit explicit files:

```bash
git add stats.ts core/engine.ts steering.ts .pi/extension/index.ts mcp/server.ts .opencode/plugins/predexec.ts __tests__/stats.test.ts __tests__/core/engine.test.ts __tests__/index.test.ts
git commit -m "fix: count cyclic runs and validate json paths"
```

---

### Task 6: Make MCP fallback search termination-safe and bounded

**Files:**
- Modify: `core/index.ts`
- Modify: `mcp/tool-ops.ts`
- Modify: `__tests__/mcp/tool-ops.test.ts`

**Interfaces:**
- Produces: public `isSafeRegex(pattern: string): boolean` export through `core/index.ts`.
- Changes internal MCP signatures: `grepViaNode(..., limit, signal)` receives the result limit.
- Preserves: grep/find exit codes 0=result, 1=no result, 2=search did not run.

- [ ] **Step 1: Add failing unsafe-regex fallback test**

Force `{ rgPath: null }`, create a text file, run grep with `(a+)+$`, and assert exit code 2 with stderr containing `unsafe pattern`. The test must complete normally without timing assertions.

- [ ] **Step 2: Add failing bounded-scan and large-read tests**

Create lexically sorted files containing more matches than `limit: 3`. Instrument filesystem reads through a narrow test seam or exported internal helper and assert fallback grep stops after establishing the fourth match, returns the first three path/line results, and emits the existing limit warning.

Create a large text fixture with requested `{offset: 2, limit: 2}` and assert output/continuation text remains byte-identical while the implementation's retained-line high-water mark stays bounded through an exported test-only-independent helper result. Do not assert process RSS or timing.

- [ ] **Step 3: Verify RED**

Run:

```bash
./node_modules/.bin/vitest run __tests__/mcp/tool-ops.test.ts
```

- [ ] **Step 4: Screen regex and stream reads**

Export `isSafeRegex` from `core/index.ts`. Before `new RegExp` in fallback grep:

```ts
if (!flags.literal && !isSafeRegex(pattern)) {
  return { err: fail("grep", "unsafe pattern: nested quantifier may not terminate") };
}
```

Implement a line iterator over `createReadStream` plus `node:readline` for text reads. Detect NUL bytes while consuming chunks. Retain only requested lines and a total-line counter; preserve one-based offset and final-newline semantics.

Sort candidate paths before scanning fallback grep. Iterate files and lines in final output order, stop at `limit + 1` matches, and pass only the first `limit` to context formatting. Retain line arrays only for files contributing returned matches, capped by the requested limit.

- [ ] **Step 5: Verify GREEN and commit**

Run tool-op tests and typecheck. Commit:

```bash
git add core/index.ts mcp/tool-ops.ts __tests__/mcp/tool-ops.test.ts
git commit -m "fix: bound MCP fallback reads and regex search"
```

---

### Task 7: Enforce truthful MCP symlink containment

**Files:**
- Modify: `mcp/tool-ops.ts`
- Modify: `mcp/server.ts`
- Modify: `__tests__/mcp/tool-ops.test.ts`
- Modify: `__tests__/mcp/server.test.ts`
- Modify: `README.md`

**Interfaces:**
- Produces: realpath containment for existing MCP tool targets.
- Preserves: dependency symlinks whose lexical path contains a `node_modules` segment.

- [ ] **Step 1: Add failing symlink escape tests**

Create a root directory and a separate outside directory with `secret.txt`. Add `root/link -> outside`. Assert `read link/secret.txt`, `grep` scoped to the link, and `ls link` fail with text containing `symlink resolves outside the predexec root`.

Create `root/node_modules/pkg -> outside/pkg` and assert reading `node_modules/pkg/package.json` succeeds. Skip only on platforms where symlink creation itself is unavailable.

- [ ] **Step 2: Verify RED**

Run MCP tool-op tests. Expected: ordinary symlink escape succeeds today.

- [ ] **Step 3: Implement realpath-aware target checks**

After lexical `locate` and existence checks, resolve both root and target using `realpath`. Reject an outside resolved target unless the lexical relative path has a path segment exactly equal to `node_modules`:

```ts
const dependencyPath = relative(root, lexicalAbs).split(sep).includes("node_modules");
if (!isWithin(realRoot, realTarget) && !dependencyPath) return outsideSymlinkError(...);
```

Use the real target for the operation after validation. Keep recursive walks from following directory symlinks.

Update MCP plan-description prose and README containment documentation to say dependency symlinks below `node_modules` are the sole exception.

- [ ] **Step 4: Verify GREEN and commit**

Run tool-op/server tests, typecheck, and commit:

```bash
git add mcp/tool-ops.ts mcp/server.ts README.md __tests__/mcp/tool-ops.test.ts __tests__/mcp/server.test.ts
git commit -m "fix: reject MCP symlink escapes"
```

---

### Task 8: Deepen policy from shell commands to operations

**Files:**
- Modify: `core/types.ts`
- Modify: `core/engine.ts`
- Modify: `policy.ts`
- Modify: `mcp/policy-claude.ts`
- Modify: `mcp/server.ts`
- Modify: `.opencode/plugins/predexec.ts`
- Modify: `__tests__/core/engine.test.ts`
- Modify: `__tests__/policy.test.ts`
- Modify: `__tests__/mcp/policy-claude.test.ts`
- Modify: `__tests__/mcp/server.test.ts`

**Interfaces:**
- Replaces: `RunOptions.checkCommandPolicy?: (cmd: string) => string | null`.
- Produces: `OperationPolicyChecker = (operation: Operation) => string | null` and `RunOptions.checkOperationPolicy?: OperationPolicyChecker`.
- Preserves: all existing Bash checker behavior and verdict strings.

- [ ] **Step 1: Add failing engine policy tests for every operation**

Pass a checker that records operations and denies `{tool:"read", path:".env"}`. Assert the read executor is never called, `stoppedReason === "policyStop"`, and the transcript names the operation and rule. Assert shell strings and `{tool:"bash"}` still reach the checker.

- [ ] **Step 2: Add failing Claude and opencode fixture tests**

Claude settings fixture:

```json
{
  "permissions": {
    "deny": ["Read(./.env)", "Grep(./secrets/**)"],
    "ask": ["Glob(./private/**)"]
  }
}
```

Assert mapped `read`, `grep`, `find`, and `ls` operations stop on matching static rules while unrelated paths pass. Preserve Bash precedence tests.

Opencode config fixture:

```json
{
  "permission": {
    "read": {".env": "deny", "*": "allow"},
    "grep": {"secrets/**": "ask", "*": "allow"},
    "list": {"private/**": "deny", "*": "allow"}
  }
}
```

Assert last matching rule wins independently within each tool's entries.

- [ ] **Step 3: Verify RED**

Run engine, policy, Claude policy, and MCP server tests. Expected: non-bash operations skip policy.

- [ ] **Step 4: Implement normalized operation checking**

Add:

```ts
export type OperationPolicyChecker = (operation: Operation) => string | null;
```

The engine calls it for every item before any item in the node runs. A shell string remains a string; `{tool:"bash"}` remains the full object so adapters can inspect `command`; native tool operations remain objects. Update policy-block formatting through `formatToolOpLabel`.

Extend host policy readers with operation-aware wrapper functions while keeping their existing parsing and precedence private. Claude maps `read`/`ls` to `Read`, `grep` to `Grep`, and `find` to `Glob`; opencode maps to `read`/`grep`/`list`. Codex wraps only shell operations because no persisted file-operation rule source exists. Pi supplies no extra checker and continues through native adapters.

Unreadable configured policy files return a denial for every governed operation. Do not claim Codex execpolicy governs file reads.

- [ ] **Step 5: Verify GREEN and commit**

Run all policy, engine, MCP server, opencode, and Pi tests plus typecheck. Commit explicit files:

```bash
git add core/types.ts core/engine.ts policy.ts mcp/policy-claude.ts mcp/server.ts .opencode/plugins/predexec.ts __tests__/core/engine.test.ts __tests__/policy.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/server.test.ts
git commit -m "fix: enforce host policy for tool operations"
```

---

### Task 9: Consolidate command inspection and plan-language teaching

**Files:**
- Create: `command-inspection.ts`
- Create: `plan-language.ts`
- Modify: `policy.ts`
- Modify: `mcp/policy-claude.ts`
- Modify: `mcp/policy-codex.ts`
- Modify: `mcp/server.ts`
- Modify: `.opencode/plugins/predexec.ts`
- Modify: `.pi/extension/index.ts`
- Modify: `steering.ts`
- Create: `__tests__/command-inspection.test.ts`
- Create: `__tests__/plan-language.test.ts`
- Modify: `__tests__/policy.test.ts`
- Modify: `__tests__/mcp/policy-claude.test.ts`
- Modify: `__tests__/mcp/policy-codex.test.ts`
- Modify: `__tests__/mcp/server.test.ts`
- Modify: `__tests__/opencode.test.ts`
- Modify: `__tests__/pi.test.ts`

**Interfaces:**
- Produces from `command-inspection.ts`: `extractCommandSubstitutions`, `tokenizeShellWords`, and `stripLeadingAssignmentsAndWrappers`.
- Produces from `plan-language.ts`: canonical field/tool/limit constants and `PLAN_SHAPE_DESCRIPTION`.
- Preserves: separate host policy parsing, matching, precedence, and verdict selection.

- [ ] **Step 1: Write parity tests before extraction**

Create table-driven tests covering newline joins, `$()`, backticks, process substitution, quoted tokens, environment assignments, and wrapper chains. Assert the new mechanical functions' desired outputs.

Create plan-language tests asserting the canonical description contains all condition kinds, tool names, `MAX_OPERATIONS_PER_NODE`, `MAX_PARALLEL_CONCURRENCY`, relative cwd rule, and the single-operation JSON-path rule. Assert MCP and opencode descriptions contain the canonical description and Pi's schema represents the same field names and numeric ceilings.

- [ ] **Step 2: Verify RED**

Run the two new test files. Expected: module-not-found failures for the not-yet-created modules.

- [ ] **Step 3: Extract only identical command mechanics**

Move mechanically identical logic into `command-inspection.ts`. Each policy adapter imports it but keeps its own wrapper sets when those sets differ; pass the wrapper set as an argument rather than hiding host semantics globally. Do not move pattern parsing, rule ordering, or verdict calculation.

- [ ] **Step 4: Centralize plan-language facts**

Export immutable arrays/constants for condition kinds and tool operation names plus a composed description. MCP and opencode concatenate the canonical description with their adapter-only parity notes. Pi uses the constants to build enum values, descriptions, and `maxItems: 64`; retain its intentional wording differences.

Remove only duplication covered by the new parity tests. Apply the deletion test: if an extracted wrapper merely renames one call without hiding mechanics, inline it.

- [ ] **Step 5: Verify GREEN and commit**

Run new tests, all policy/adapter tests, and typecheck. Commit:

```bash
git add command-inspection.ts plan-language.ts policy.ts steering.ts mcp/policy-claude.ts mcp/policy-codex.ts mcp/server.ts .opencode/plugins/predexec.ts .pi/extension/index.ts __tests__/command-inspection.test.ts __tests__/plan-language.test.ts __tests__/policy.test.ts __tests__/mcp/policy-claude.test.ts __tests__/mcp/policy-codex.test.ts __tests__/mcp/server.test.ts __tests__/opencode.test.ts __tests__/pi.test.ts
git commit -m "refactor: centralize command and plan language mechanics"
```

---

### Task 10: Cross-adapter release verification

**Files:**
- Modify only if verification exposes a regression: the smallest owning source/test files.
- Verify: `README.md`, `CLAUDE.md` invariants, package contents, compiled `dist/` output.

**Interfaces:**
- Consumes all prior tasks.
- Produces a release-ready local branch; no publish, push, merge, or version bump.

- [ ] **Step 1: Run focused invariant suites**

```bash
./node_modules/.bin/vitest run \
  __tests__/core \
  __tests__/policy.test.ts \
  __tests__/mcp/policy-claude.test.ts \
  __tests__/mcp/policy-codex.test.ts \
  __tests__/mcp/tool-ops.test.ts \
  __tests__/mcp/server.test.ts \
  __tests__/pi.test.ts \
  __tests__/opencode.test.ts \
  __tests__/stats.test.ts
```

Expected: all pass with no skipped regression tests except platform-specific symlink skips.

- [ ] **Step 2: Run full static and runtime verification**

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
pnpm run build
./node_modules/.bin/vitest run __tests__/release-hygiene.test.ts __tests__/pack.test.ts
```

Expected: typecheck passes, every test passes, build succeeds, packed tarball installs real production dependencies and loads all declared entries.

- [ ] **Step 3: Inspect scope and documentation truthfulness**

```bash
git diff --check
git status --short
git log --oneline --decorate -15
```

Confirm:

- no runtime dependency was added;
- no harness import entered `core/`;
- `dist/` is not staged;
- user-owned `PLAN.post-0.3.1-archive.md` and `CODEX-RESEARCH.md` remain untracked and unchanged;
- README/description claims match cwd, policy, truncation, and symlink behavior.

- [ ] **Step 4: Commit verification-only corrections if required**

If verification required source or documentation corrections, first add a focused regression test, observe it fail, implement the minimum correction, rerun its owning suite, and commit explicit paths with:

```bash
git commit -m "fix: close audit integration regressions"
```

If no correction is needed, create no empty commit.

- [ ] **Step 5: Request final whole-branch review**

Generate the SDD review package from the branch merge-base through HEAD. The final Luna reviewer must assess spec compliance, correctness, security, performance, test quality, and whether deferred findings block integration.

## Definition of Done

- [ ] Tasks 1-10 have completion entries in the SDD ledger.
- [ ] Every production behavior change has recorded RED and GREEN evidence.
- [ ] Every task received independent spec-compliance and code-quality approval.
- [ ] Every audit concern is implemented or has an explicit reviewed ruling in the ledger.
- [ ] Full tests, typecheck, build, and packed-install verification pass.
- [ ] Final whole-branch review is clean or residual findings are explicitly adjudicated.
- [ ] Nothing was pushed, published, merged, or version-bumped.
