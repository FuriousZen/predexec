# predexec Harness Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the audited safety and compatibility defects in predexec 0.4.1, restructure the shell-classification core, make every harness (pi, opencode, Claude Code, Codex, Antigravity) load its routing prompt as a shipped `SKILL.md`, and add Antigravity as a fifth host.

**Architecture:** Fix the confirmed read-only and termination bugs in core first, test-first. Then consolidate the three shell lexers into one `core/shell/` module tree, which the refactor must keep behavior-identical (the whole suite is the oracle). After that, fix each adapter's policy and tool-op defects. Next, generate all harness skills from one source in `steering.ts` and wire each harness's native skill-shipping mechanism. Last, add `--host antigravity` on the shared MCP server, based on live measurements.

**Tech Stack:** Node.js 22+, TypeScript 5.9, Vitest 4, pnpm 11, `@modelcontextprotocol/server` v2, zod 4.

**Spec:** `docs/superpowers/specs/2026-09-25-harness-refresh-audit.md`. Finding IDs such as `CORE-1` and `CX-2` refer to it. Read the finding before starting a task that cites it.

**Project context:** `/Users/williamwo/Development/personal/predexec/CLAUDE.md` sits in the parent directory, outside this git repo. Its "Invariants" and "Hard-won details" sections are binding: do not undo any hard-won detail unless a task below explicitly changes it.

## Global Constraints

- `core/` stays pure TypeScript with zero harness imports and zero third-party runtime dependencies. After Task 5, `core/` imports nothing outside `core/`.
- Add no production dependency. The production closure stays `@modelcontextprotocol/server`, `@modelcontextprotocol/core` and `zod`.
- Mutating nodes hard-stop before execution. Mutation execution stays out of scope.
- Preserve the host policy semantics:
  - opencode: last-match-wins over the flattened ruleset.
  - Claude Code: deny → ask → allow.
  - Codex: most-restrictive-wins.
  - Antigravity: Deny > Ask > Allow.
- Every policy reader fails closed on anything it cannot parse, *except* the explicitly tolerated constructs named in Task 13.
- `mcp/server.ts` never writes to stdout. The tool DESCRIPTION stays host-neutral.
- No root `.mcp.json` in the repo. It would register a live Claude Code project-scope server.
- Every production behavior change starts with a focused failing test, and you must see it fail for the expected reason.
- Focused tests: `./node_modules/.bin/vitest run <files>`. Typecheck: `./node_modules/.bin/tsc --noEmit`. Full gate: `pnpm run build && ./node_modules/.bin/vitest run`.
- The baseline is 1592 passing and 1 skipped. The suite count only goes up.
- Stage with explicit `git add <paths>` and never `git add -A`. Use conventional-commit messages (`fix:`, `feat:`, `refactor:`, `docs:`, `chore:`, `test:`).
- Work on branch `harness-refresh`, never on `main`. Do not publish to npm and do not push.
- Skill frontmatter: `name` matches `^[a-z0-9]+(-[a-z0-9]+)*$` and is at most 64 chars. `description` is 1–1024 chars and carries the full routing rule, because most hosts keep only name and description resident.

## Review Focus

1. **A policy reader meeting host-written config it has never seen.** Examples: Codex `network_rule(...)`, `[[skills.config]]`, an opencode agent override. It should keep enforcing the rules it *can* read, not silently allow and not refuse everything. Tests: Task 10 and Task 13.
2. **A plan run from a subdirectory or a symlinked path of a repo.** Policy, trust, containment and skill discovery must resolve to the same project root the host uses. Tests: Task 8, Task 13 and Task 20.
3. **A model-authored plan that blocks forever.** Causes include stdin reads, `tail -f`, a slow regex, or a hung tool op. The walk must return a bounded, explicitly-marked failure. Tests: Task 1 and Task 2.
4. **The same skill loaded twice, or a skill naming the wrong tool.** Cases: plugin plus manual install, a Claude skill picked up by opencode's `.claude/skills` scan, or the plugin-namespaced tool name. Doctor must flag it, and skill text must not hardcode a tool id that varies by install. Tests: Task 14 and Task 15.
5. **Tool-op failure versus an empty result.** On every host, "never ran" (exit 2) must differ from "ran, found nothing" (exit 1). Tests: Task 11 and Task 12.

---

## Phase 0 — Workspace

### Task 0: Host-runnable toolchain, build-independent tests, repo hygiene

Covers ENV-1, BLD-1, DOC-1 (the hygiene part).

**Files:**
- Modify: `pnpm-workspace.yaml` (gitignored, local only). Add `supportedArchitectures` and resolve the placeholder `allowBuilds`.
- Create: `__tests__/helpers/global-setup.ts`
- Modify: `vitest.config.ts`
- Move: `PLAN.md` from HEAD → `docs/superpowers/plans/2026-08-29-audit-remediation.md` (the previous plan is closed; this file already replaced it in the working tree, so recover it with `git show HEAD:PLAN.md`)
- Remove from index: `.superpowers/sdd/PLAN/task-*-report.md`. Add `.superpowers/` to `.gitignore`.

- [ ] **Step 1:** Create the branch: `git switch -c harness-refresh`.
- [ ] **Step 2:** Make `node_modules` work on both macOS and the Linux devcontainer. In `pnpm-workspace.yaml` set:

  ```yaml
  supportedArchitectures:
    os: [current, linux]
    cpu: [current]
    libc: [current, glibc]
  ```

  Set every `allowBuilds` placeholder to `false`. Delete the stale `minimumReleaseAgeExclude` entries for `@opencode-ai/*@1.18.14`. Then run `pnpm install --frozen-lockfile`. If pnpm complains about the `/workspaces/.pnpm-store` store path, run `pnpm install --frozen-lockfile --store-dir ../.pnpm-store`.

  Verify with `ls node_modules/.pnpm | grep rolldown+binding`. Both `darwin-arm64` and `linux-arm64-gnu` must be present.
- [ ] **Step 3:** Confirm BLD-1 reproduces. Run `rm -rf dist && ./node_modules/.bin/vitest run __tests__/pi.test.ts`. Expected: FAIL resolving `../dist/.pi/extension/index.js`.
- [ ] **Step 4:** Add a global setup that builds once:

  ```ts
  // __tests__/helpers/global-setup.ts
  import { ensureBuild } from "./ensure-build.ts";
  export default function setup(): void { ensureBuild(); }
  ```

  In `vitest.config.ts`, add `globalSetup: ["__tests__/helpers/global-setup.ts"]` under `test`. Check the actual export name in `__tests__/helpers/ensure-build.ts` and use it.
- [ ] **Step 5:** Run `rm -rf dist && ./node_modules/.bin/vitest run`. Expected: all pass (1592 + 1 skipped).
- [ ] **Step 6:** Archive the old plan and clean up the scratch files:

  ```bash
  git show HEAD:PLAN.md > docs/superpowers/plans/2026-08-29-audit-remediation.md
  git rm --cached -r .superpowers
  echo ".superpowers/" >> .gitignore
  ```
- [ ] **Step 7:** Commit. `git add vitest.config.ts __tests__/helpers/global-setup.ts .gitignore docs/superpowers PLAN.md` then `git commit -m "chore: build dist in vitest globalSetup; archive previous plan"`.

---

## Phase 1 — Core safety (HIGH)

### Task 1: Runner termination, stdin, and output fidelity

Covers CORE-3, CORE-6, CORE-8, and CORE-10 (the UTF-8 part and the stale comment).

**Files:**
- Modify: `core/runner.ts`, `core/types.ts`
- Test: `__tests__/core/runner.test.ts`

**Interfaces:**
- Produces:
  - `RunOptions.commandTimeoutMs?: number`, clamped to `[1_000, MAX_COMMAND_TIMEOUT_MS]`.
  - `DEFAULT_COMMAND_TIMEOUT_MS = 60_000` and `MAX_COMMAND_TIMEOUT_MS = 600_000`, exported from `core/types.ts`.
  - Timed-out commands report `exitCode: 124` (the GNU `timeout` convention) and a stderr line `[predexec] command timed out after <ms>ms`.

- [ ] **Step 1: Write the failing tests.**

  ```ts
  describe("runNode — termination", () => {
    it("gives shell commands a closed stdin", async () => {
      const r = await runNode({ id: "n", commands: ["cat"] }, { cwd });
      expect(r.exitCode).toBe(0);           // EOF immediately, no hang
    }, 5_000);

    it("kills a command that exceeds commandTimeoutMs, including its children", async () => {
      const r = await runNode({ id: "n", commands: ["sh -c 'sleep 30 & sleep 30'"] }, { cwd, commandTimeoutMs: 1_000 });
      expect(r.exitCode).toBe(124);
      expect(r.stderr).toContain("[predexec] command timed out after 1000ms");
    }, 5_000);

    it("reports the true number of dropped chars", async () => {
      const r = await runNode({ id: "n", commands: ["seq 1 100000"] }, { cwd });
      const m = r.stdout.match(/…\[truncated: (\d+) more chars\]/);
      expect(Number(m?.[1])).toBeGreaterThan(500_000);
    });

    it("decodes multi-byte UTF-8 split across chunks", async () => {
      const q = String.fromCharCode(39);
      const script = 'const b=Buffer.from("é");process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30)';
      const r = await runNode({ id: "n", commands: [`node -e ${q}${script}${q}`] }, { cwd });
      expect(r.stdout).toContain("é");
    });
  });
  ```

  Also add a parallel-abort test. Use a node with 3 commands, `parallel:true`, and an `AbortController` fired after the first command completes. Assert that every `[i]` label in the output matches the command at index `i-1`.
- [ ] **Step 2:** Run `./node_modules/.bin/vitest run __tests__/core/runner.test.ts`. Expected: the `cat` test times out, the timeout test times out, the truncated count is about 28, `é` is mangled, and the labels are wrong.
- [ ] **Step 3: Implement.**
  - `spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] })`.
  - `child.stdout.setEncoding("utf8")`, and the same for stderr.
  - A timer that calls `process.kill(-child.pid, "SIGKILL")` (the process group). Wrap it in try/catch, because the group may already be gone.
  - Replace `signal:` with a manual `abort` listener that kills the group the same way, and remove the listener in `finish`.
  - Track `totalChars` in `runShell`, and pass it to `cap()` as the original length instead of re-capping text that is already marked.
  - In `runParallel`, keep the original index with each result, so `joinLabeled` gets `(index, output)` pairs rather than a filtered array.
  - Fix the `runner.ts:16` comment so it names the file that actually reads `TRUNCATION_MARKER`, or delete the claim.
- [ ] **Step 4:** Run the runner, engine and adapter-runtime tests. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(core): close stdin, bound command runtime, kill process groups, fix truncation counts`.

### Task 2: Regex termination and condition-path confinement

Covers CORE-2 and CORE-9.

**Files:**
- Modify: `core/conditions.ts`
- Test: `__tests__/core/conditions.test.ts`

- [ ] **Step 1: Write the failing tests.**

  ```ts
  const CATASTROPHIC = ["((a+))+$", "(a+b?)+$", "(\\w+\\s?)+$", "(a+){12}$", "((?:a|b)+c?)*$", "(x+x+)+y"];
  const SAFE = ["(?:\\d+\\.)+\\d+", "^v\\d+(?:\\.\\d+){2}$", "(ab)+", "(a|b){3}", "\\w+", "(foo\\s)+bar"];
  it.each(CATASTROPHIC)("rejects %s", (p) => expect(isSafeRegex(p)).toBe(false));
  it.each(SAFE)("accepts %s", (p) => expect(isSafeRegex(p)).toBe(true));

  it("every accepted pattern runs in bounded time on adversarial input", () => {
    const gen = ["a", "b?", "\\w", "\\s?", "a+", "(a+)", "(?:a|b)", "\\d+"];
    for (const x of gen) for (const y of gen) for (const q of ["+", "*", "{2,}", "{5}"]) {
      const p = `(${x}${y})${q}$`;
      if (!isSafeRegex(p)) continue;
      const t0 = performance.now();
      new RegExp(p).test("a".repeat(28) + "!");
      expect(performance.now() - t0, p).toBeLessThan(50);
    }
  });

  it("fileExists refuses paths outside the session root", () => {
    expect(evaluateConditionWithDetail({ kind: "fileExists", path: "../../etc/hosts" }, out, { cwd }).matched).toBe(false);
    expect(evaluateConditionWithDetail({ kind: "fileExists", path: "/etc/hosts" }, out, { cwd }).matched).toBe(false);
  });
  ```

  Check the actual `evaluateConditionWithDetail` signature at `core/conditions.ts:542` and adapt the call. The result must carry a detail reason that mentions "outside session root".
- [ ] **Step 2:** Run the tests and watch them fail.
- [ ] **Step 3: Implement.**
  - Classify a quantified group (`+`, `*`, `{n,}`, or `{n,m}` with `m ≥ 2`) as unsafe when its body *can end open-ended*. That holds when the last **non-optional** atom is open-ended, meaning a `+`/`*`/`{n,}`-quantified atom or a nested group whose own body can end open-ended. It also holds when the body has two adjacent open-ended atoms over overlapping classes (`x+x+`).
  - Reuse the existing `parseSequence` / `nestedEndsOpenEnded` helpers. Do not add a second parser.
  - For `fileExists`, resolve the path against `cwd` and refuse when the resolved path is not inside the session root, using the containment rule `resolvePlanCwd` uses (`core/engine.ts:157`).
- [ ] **Step 4:** Run the conditions and engine tests, plus `__tests__/plan-language.test.ts`. Expected: PASS. The property test must also pass, with no pattern over 50 ms.
- [ ] **Step 5:** Commit: `fix(core): close isSafeRegex bypasses; confine fileExists to session root`.

### Task 3: Read-only heads that write or exec

Covers CORE-1.

**Files:**
- Modify: `core/destructive.ts` (`READ_ONLY_HEADS`, `HEAD_EXCEPTIONS`, `AWK_WRITE_RE` around `:220-247` and `:1557`)
- Create: `__tests__/core/read-only-heads.test.ts`

- [ ] **Step 1:** Write a table-driven escape suite. Every row must be classified mutating:

  ```ts
  import { isDestructiveCommand } from "../../core/index.ts";
  const ESCAPES = [
    "sed -n 'w SED_W.txt' in.txt", "sed -n 'W out' f", "sed '1e touch x' f", "sed --in-place s/a/b/ f",
    "sed -Ei s/a/b/ f", "sed -ni.bak p f", "sort --output=o.txt f", "sort -oo.txt f", "sort -o o.txt f",
    "sort --compress-program=sh f", "awk 'BEGIN{print \"x\" | \"sh\"}'", "awk 'BEGIN{\"touch x\" | getline}'",
    "awk '{print > \"f\"}' in", "gawk -i inplace '{print}' f", "xxd in.txt out.txt", "xxd -r a b",
    "rg --pre ./x.sh hello f", "rg --pre=./x.sh hello f", "tree -o out.txt", "find . -fprint out",
    "find . -fls out", "find . -fprintf out %p", "find . -okdir rm {} ;", "find . -delete",
    "less -o log f", "less --log-file=log f", "yq -i .a=1 f.yaml", "jq -n 'input' --rawfile x /dev/stdin",
  ];
  const SAFE = ["sed -n 1,5p f", "sort -r f", "awk '{print $1}' f", "xxd f", "rg hello", "tree -L 2", "find . -name '*.ts'", "less f", "yq .a f.yaml"];
  it.each(ESCAPES)("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));
  it.each(SAFE)("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));
  ```

  Drop the `jq` row if `--rawfile` is genuinely read-only after checking. It is there to force the question, not as a fixed requirement.
- [ ] **Step 2:** Run the suite and watch the ESCAPES rows fail.
- [ ] **Step 3: Implement.** Change `HEAD_EXCEPTIONS` from one regex per head to an **argv predicate** per head, built on the existing tokenizer. `(argv: string[]) => boolean` returns true when the invocation writes or execs.
  - **sed:** any `-i`/`--in-place` in a short-flag cluster or long form, any script containing `w`/`W`/`e` commands, or an `s///w` / `s///e` flag.
  - **sort:** `-o`, `-o<file>`, `--output`, `--compress-program`.
  - **awk / gawk / mawk:** `-i inplace`, and any program containing `>`/`>>`, `|` followed by a string, `| getline`, or `system(`.
  - **xxd:** more than one positional argument, or `-r`.
  - **rg:** `--pre`, `--pre=`.
  - **tree:** `-o`.
  - **find:** `-delete`, `-exec*`, `-ok*`, `-fprint*`, `-fls`.
  - **less:** `-o`, `-O`, `--log-file`, `--LOG-FILE`.
  - **yq:** `-i`, `--inplace`.

  Remove a head from `READ_ONLY_HEADS` entirely if its predicate cannot be written confidently.
- [ ] **Step 4:** Run `./node_modules/.bin/vitest run __tests__/core` and `__tests__/command-inspection.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(core): classify write/exec flags of read-only heads by argv`.

### Task 4: Wrapper parity and interpreter-eval inversion

Covers CORE-4 and CORE-5.

**Files:**
- Modify: `core/destructive.ts` (`WRAPPERS` `:1609`; interpreter scan `:258-267`)
- Test: `__tests__/core/destructive.test.ts` (or whichever existing file holds the destructive tests; find it with `grep -l isDestructiveCommand __tests__/core`)

- [ ] **Step 1: Write the failing tests.**

  ```ts
  it.each([
    `timeout 5 node -e "require('fs').writeFileSync('x','y')"`,
    `stdbuf -o0 python3 -c "open('x','w').write('y')"`,
    `noglob python3 -c "open('x','w').write('y')"`,
    `python3 -c "import os; os.replace('a','b')"`,
    `python3 -c "__import__('os').system('touch x')"`,
    `ruby -e 'IO.write("x","y")'`,
    `perl -e 'unlink "x"'`,
    `node -e "require('child_process').execSync('touch x')"`,
  ])("mutating: %s", (c) => expect(isDestructiveCommand(c)).toBe(true));

  it.each([
    `python3 -c "import json,sys; print(json.load(open('p.json'))['version'])"`,
    `node -e "console.log(require('./package.json').version)"`,
    `python3 --version`,
  ])("read-only: %s", (c) => expect(isDestructiveCommand(c)).toBe(false));

  it("core WRAPPERS is a superset of command-inspection DEFAULT_WRAPPERS", () => { /* import both sets, assert ⊇ */ });
  ```

  Export whatever you need for the parity test. Task 5 deletes the duplication, so this test is temporary scaffolding. It becomes trivially true in Task 5, and you should keep it there anyway.
- [ ] **Step 2:** Run the tests and watch them fail.
- [ ] **Step 3: Implement.**
  - Add `timeout`, `stdbuf` and `noglob` to the core `WRAPPERS`, including their option-and-duration argument skipping. Copy that from `command-inspection.ts`.
  - Invert the interpreter rule. An inline `-c`/`-e`/`--eval`/`-p` payload counts as **mutating unless** every call it makes matches a small reader allowlist.
    - Python: `print`, `open(<path>)` with no mode or an `'r'`/`'rb'` mode, `json.load(s)`, `sys.*`, `os.path.*`, `os.listdir`, `os.getcwd`, `os.environ.get`.
    - Node: `console.log`, `require('<relative json>')`, `JSON.*`, `process.version*`, `fs.readFileSync`, `fs.existsSync`, `fs.readdirSync`, `fs.statSync`.
    - Ruby and Perl: `puts`, `print`, `File.read`, `JSON.parse`.

  Keep the existing obfuscation screens. Payloads that call nothing (`python3 --version`) stay read-only.
- [ ] **Step 4:** Run `./node_modules/.bin/vitest run __tests__/core __tests__/command-inspection.test.ts`. Expected: PASS. If some existing read-only expectations now flip to mutating, review each one: keep the flip when the old expectation was an escape, and widen the allowlist when it was a genuine reader.
- [ ] **Step 5:** Commit: `fix(core): wrapper parity and allowlist-based interpreter eval classification`.

---

## Phase 2 — Core architecture (behavior-preserving)

### Task 5: `core/shell/` — one tokenizer, one wrapper vocabulary, shared constants

Covers ARCH-1, ARCH-2, ARCH-4, and CORE-7.

**Files:**
- Create: `core/shell/lexer.ts`. It holds the one tokenizer, clause splitter, parenthesized-body and substitution walker, and wrapper and assignment stripping, all merged from `command-inspection.ts` and `destructive.ts`.
- Move: `command-inspection.ts` → `core/shell/inspection.ts` (a thin layer over `lexer.ts`).
- Modify: `core/destructive.ts`, `core/index.ts`, `core/types.ts`, `core/coerce.ts`, `core/validation.ts`, `plan-language.ts`, `core/engine.ts`, and every importer of `command-inspection.ts` (`grep -rl command-inspection --include=*.ts .`).
- Move: `__tests__/command-inspection.test.ts` → `__tests__/core/shell/inspection.test.ts`.

**Interfaces:**
- Produces:
  - `core/shell/lexer.ts` exports `tokenizeShellWords`, `splitCommandSegments` (now backslash-aware), `extractShellCommandClauses`, `stripLeadingAssignmentsAndWrappers`, and `WRAPPERS: ReadonlySet<string>`, the single source.
  - `core/types.ts` exports `CONDITION_KINDS` (readonly tuple), `TOOL_NAMES` (readonly tuple `["read","grep","find","ls"]`) and `JSON_PATH_SINGLE_OP_MESSAGE`. `HIGH_CONFIDENCE_KINDS`, coerce's `VALID_KINDS`, validation's and plan-language's tool lists, and engine/plan-language's jsonPath message are all derived from these.
- Preserves: every existing export name reachable from `core/index.ts` (including `inspectCommandSubstitutionTree` and `splitCommandSegments`).

- [ ] **Step 1: Failing tests.** Add an invariant test:

  ```ts
  // __tests__/core/purity.test.ts
  import { readdirSync, readFileSync } from "node:fs"; import { join, resolve, relative } from "node:path";
  it("core/ imports nothing outside core/", () => {
    const root = resolve("core"); const bad: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name); if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) for (const m of readFileSync(p, "utf8").matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1]; if (!spec.startsWith(".")) { if (!spec.startsWith("node:")) bad.push(`${p}: ${spec}`); continue; }
        if (relative(root, resolve(d, spec)).startsWith("..")) bad.push(`${p}: ${spec}`);
      } } };
    walk(root); expect(bad).toEqual([]);
  });
  ```

  Add a backslash-escape test (CORE-7). In `echo \"; touch X; echo \"` the quotes are escaped, so the `;` separators are live: `expect(splitCommandSegments('echo \\"; touch X; echo \\"')).toEqual(['echo \\"', 'touch X', 'echo \\"'])`. Today it returns 1 segment.
- [ ] **Step 2:** Run the tests and watch them fail. The purity test lists `destructive.ts` and `index.ts`.
- [ ] **Step 3:** Move and merge. Where the two lexers disagree, keep the stricter behavior (the one that yields more clauses or more mutating verdicts) and add a test pinning it. Delete `shellWords`, `shellArguments`, `parenthesizedGroups`, `normalizeEnvInvocation` and `effectiveHead` from `destructive.ts` once their callers use `lexer.ts`. Also delete the Task 4 parity scaffolding once only one `WRAPPERS` set exists; keep a test that asserts `WRAPPERS.has("timeout")`.
- [ ] **Step 4:** Run the full gate: `pnpm run build && ./node_modules/.bin/vitest run`. Expected: every pre-existing test passes, unmodified apart from import paths.
- [ ] **Step 5:** Commit: `refactor(core): consolidate shell lexing into core/shell; single-source constants`.

### Task 6: Split `destructive.ts` by concern

Covers ARCH-3.

**Files:**
- Create:
  - `core/shell/interpreters.ts`: language-payload scanning, currently about `destructive.ts:282-1560`.
  - `core/shell/git.ts`: git read-only and config-key classification.
- Modify: `core/destructive.ts`. It becomes a short pipeline of segments → clauses → per-clause argv classification, with a redirect check, privilege stop, head policy, interpreter scan and git check. Remove the double `extractShellCommandClauses` recursion at `:2385-2394`.

- [ ] **Step 1:** Record a baseline. Add `__tests__/core/destructive-corpus.test.ts`. It collects every command string used across `__tests__/**` (grep them into a JSON fixture `__tests__/fixtures/command-corpus.json`, committed) and snapshots `isDestructiveCommand` over the corpus with `toMatchSnapshot()`. Run it and commit the snapshot *before* refactoring.
- [ ] **Step 2:** Split the file. No behavior changes.
- [ ] **Step 3:** Run the corpus snapshot and the full gate. Expected: the snapshot is unchanged and everything passes. `wc -l core/destructive.ts` should be under 700.
- [ ] **Step 4:** Commit in two parts: `test(core): snapshot destructive classification corpus`, then `refactor(core): split destructive.ts into interpreters and git modules`.

### Task 7: Async-capable policy hook, inner-shell policy expansion, small core cleanups

Covers ARCH-5, CX-5 (the core part), and CORE-10 (stats and coerce).

**Files:**
- Modify: `core/types.ts` (`OperationPolicyChecker` return type), `core/engine.ts` (`findPolicyViolation`), `stats.ts:87`, `core/coerce.ts`
- Test: `__tests__/core/engine.test.ts`, `__tests__/stats.test.ts`, `__tests__/core/coerce.test.ts`

**Interfaces:**
- Produces:
  - `type OperationPolicyChecker = (op: Operation, ctx: { cwd: string; sessionRoot: string; signal?: AbortSignal }) => PolicyVerdict | Promise<PolicyVerdict>`. Keep the existing parameter shape if it differs, and only widen the return type.
  - The engine now calls the checker for each shell operation **and** for each inner command of `sh|bash|zsh|dash -c|-lc|-ic '<script>'` (split into clauses by `core/shell/lexer.ts`), and it also calls the checker with an absolute-path head basename-normalized (`/bin/cat .env` → `cat .env`). Adapters get this for free.

- [ ] **Step 1: Failing tests.**

  ```ts
  it("awaits an async policy checker", async () => {
    const r = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: ["ls"] }] },
      { cwd, checkOperationPolicy: async () => "denied by host" });
    expect(r.stoppedReason).toBe("policyStop");
  });
  it.each(["bash -lc 'cat .env'", "sh -c \"cat .env\"", "/bin/cat .env"])("policy sees inner command of %s", async (c) => {
    const seen: string[] = [];
    await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [c] }] },
      { cwd, checkOperationPolicy: (op) => { if (typeof op === "string") seen.push(op); return typeof op === "string" && op.startsWith("cat .env") ? "deny" : null; } });
    expect(seen).toContain("cat .env");
  });
  it("coercePlan does not mutate its input", () => { const p = { root: "a", nodes: '[{"id":"a","commands":["ls"]}]' }; const c = structuredClone(p); coercePlan(p); expect(p).toEqual(c); });
  ```

  Add a stats test asserting `stats.ts` uses `estimateRequestsSaved`: spy on it, or compare outputs on a fixture where the duplicate would drift.
- [ ] **Step 2:** Run the tests and watch them fail.
- [ ] **Step 3:** Implement. `runPlanTree` is already async, so `await` the checker. Check `opts.signal` between checks.
- [ ] **Step 4:** Run the full gate. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): async policy checkers; policy sees inner shell scripts and absolute heads`.

---

## Phase 3 — Adapter defects

### Task 8: Claude Code / Codex tool-op containment

Covers CC-1.

**Files:**
- Modify: `mcp/tool-ops.ts:~302` (the `node_modules` realpath exemption)
- Test: `__tests__/mcp/tool-ops.test.ts`

- [ ] **Step 1: Failing test.** In a tmp root, create `node_modules/evil -> <tmp outside dir containing secret.txt>`. Then check that:
  - `{tool:"read",path:"node_modules/evil/secret.txt"}` returns exit 2 with stderr mentioning "outside".
  - `grep` and `find` rooted at `node_modules/evil` also refuse.
  - A pnpm-style `node_modules/.pnpm/x/node_modules/pkg -> ../../x` link that stays inside the root *still reads fine*.
- [ ] **Step 2:** Run the test and watch it fail.
- [ ] **Step 3:** Delete the exemption. Containment = `realpath(target)` is inside `realpath(sessionRoot)`. If a legitimate case needs a pnpm store outside the root, allow only `realpath(<root>/node_modules)`'s *own* resolved store dir, found once at startup, and document it inline.
- [ ] **Step 4:** Run `./node_modules/.bin/vitest run __tests__/mcp`. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(mcp): remove node_modules containment exemption`.

### Task 9: Claude Code permission fidelity

Covers CC-2, CC-3, and CC-4.

**Files:**
- Create: `mcp/gitignore-match.ts`. A pure gitignore-pattern → matcher for absolute paths, no deps.
- Modify: `mcp/policy-claude.ts`, `mcp/server.ts` (checker wiring)
- Test: `__tests__/mcp/policy-claude.test.ts`, `__tests__/mcp/gitignore-match.test.ts`

**Interfaces:**
- Produces:
  - `compileClaudePathRule(rule: string, anchor: { projectDir: string; settingsDir: string; home: string }): (absPath: string) => boolean`.
  - The anchor forms (per https://code.claude.com/docs/en/permissions, "Read and Edit"): `//abs` → filesystem absolute, `~/x` → home, `/x` → relative to the settings file's source root, `./x` or a bare `x` → project-relative, `**/x` → any depth. A bare name with no slash matches at any depth, following gitignore.

- [ ] **Step 1: Failing tests.** Table test over `(rule, path, expected)`:
  - `Read(.env)` vs `config/.env` → deny
  - `Read(secrets/**)` vs `lib/secrets/x` → deny
  - `Read(//etc/**)` vs `/etc/hosts` → deny
  - `Read(~/.ssh/**)` vs `$HOME/.ssh/id_rsa` → deny
  - `Read(./.env)` vs `a/../.env` → deny (normalized)
  - symlink `link -> .env`, read `link` → deny (target checked)
  - `Read(secrets/**)` with `{tool:"grep", path:"secrets"}` and `{tool:"find", pattern:"*.pem", path:"secrets"}` → deny
  - with `deny: ["Read(./.env)"]`: shell `cat .env`, `head .env`, `cat < .env`, `tail -n1 ./.env` → policyStop
  - a rule placed only in `~/.claude/remote-settings.json` is honored

  Also check that `CLAUDE_CONFIG_DIR` relocates the user-level settings path.
- [ ] **Step 2:** Run the tests and watch them fail.
- [ ] **Step 3: Implement.**
  - The gitignore matcher supports `*`, `**`, `?`, character classes, leading `/` anchoring, trailing `/` (directory), and `!` negation (applied in order within a rule list).
  - Apply Read rules to `read`/`grep`/`find`/`ls` ops, checking both the canonical path and its realpath.
  - For shell commands, extract file operands of known readers (`cat head tail less more sed awk grep rg wc sort uniq cut tr nl od xxd file stat`) and `<` redirect targets, using `core/shell/lexer.ts` exported through `core/index.ts`. Run them through the Read rules.
  - Add `~/.claude/remote-settings.json` (and `$CLAUDE_CONFIG_DIR/...`) to `claudeSettingsPaths`.
  - macOS MDM (`/Library/Managed Preferences/com.anthropic.claudecode.plist`, a binary plist) and the Windows registry: **detect presence only**. If the file or key exists, fail closed with a policyStop reason that says managed MDM policy cannot be read by predexec. Reading them properly would add a plist parser, which is out of scope.
- [ ] **Step 4:** Run `./node_modules/.bin/vitest run __tests__/mcp`. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(mcp): gitignore-semantics Read rules for tool ops and shell readers; managed settings sources`.

### Task 10: opencode permission fidelity, plus host `context.ask` bridge

Covers OC-1, OC-2, OC-3, and OC-4.

**Files:**
- Modify: `policy.ts`, `.opencode/plugins/predexec.ts`
- Test: `__tests__/policy.test.ts`, `__tests__/opencode.test.ts`

**Interfaces:**
- Consumes: the async `OperationPolicyChecker` from Task 7.
- Produces:
  - `readOpencodeRuleset(projectDir, env): PolicyRule[] | { error: string }`. It returns the ruleset **flattened across all permission keys** in opencode's order, after mergeDeep of the config layers.
  - `createPolicyChecker` evaluates `permission` key = `bash` for shell, and `read`/`grep`/`glob`/`list` for tool ops, both through wildcard key matching. It evaluates last-match-wins over the flattened list.

- [ ] **Step 1: Failing tests** (verdicts shown are opencode's):

  ```ts
  it.each([
    [{ bash: "allow", "*": "deny" }, "ls", "deny"],
    [{ bash: { "git *": "allow" }, "*": "deny" }, "git status", "deny"],
    [{ "b*": "deny" }, "ls", "deny"],
    [{ bash: { "git log *": "deny" } }, "git log", "deny"],
    [{ read: { "~/secret/*": "deny" } }, { tool: "read", path: `${homedir()}/secret/a` }, "deny"],
  ])("opencode parity %#", /* build checker from a single config, assert verdict */);
  it("mergeDeep across global then project keeps first-appearance key order", () => {
    // global {bash:{"*":"allow","cat *":"deny"}} + project {bash:{"*":"allow"}} → `cat secret.pem` denied
  });
  it("honors agent.<name>.permission, OPENCODE_CONFIG_CONTENT, OPENCODE_DISABLE_PROJECT_CONFIG, and built-in external_directory ask for paths outside the project", ...);
  ```

  Read opencode 1.18.32's `permission/index.ts`, `config/config.ts:42-47, 414-423` and `util/wildcard.ts`. Fetch them with `npm pack @opencode-ai/opencode@1.18.32` or from GitHub tag `v1.18.32`. Mirror their order exactly, and cite file:line in comments.
- [ ] **Step 2:** Run the tests and watch them fail.
- [ ] **Step 3: Implement the static reader fixes.** Then, in the plugin, **prefer** the host bridge when `context.ask` exists on the tool context:
  - For each operation, await `context.ask({ permission: "bash", patterns: [cmd], always: [], metadata: { source: "predexec" } })`.
  - Resolved means run. A rejection is a `policyStop` whose reason says "opencode permission denied".
  - When the static reader says `ask`, the bridge lets opencode prompt the user instead of hard-stopping. This is an intentional behavior change on opencode only: document it in the README and in the skill text generated in Task 14.
  - Keep the static reader as the fallback when `context.ask` is absent. Also keep it as a *pre-check* that turns static `deny` into an immediate stop, without prompting.
- [ ] **Step 4:** Run `./node_modules/.bin/vitest run __tests__/policy.test.ts __tests__/opencode.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(opencode): flattened mergeDeep ruleset parity; bridge to host permission service`.

### Task 11: opencode tool-op fidelity

Covers OC-5, OC-6, OC-7, and OC-8, plus exit-2 parity.

**Files:**
- Modify: `.opencode/plugins/predexec.ts`
- Test: `__tests__/opencode.test.ts`

- [ ] **Step 1: Failing tests,** using the mocked v1 client:
  - `find` with `limit: 500` sends `limit ≤ 200`. It requests `min(limit,200)+1` and flags `truncated` when the extra row returns, and the stderr says so explicitly.
  - Every client call passes `directory: sessionRoot`, never a subdirectory. Subdirectory scoping is applied client-side by path prefix.
  - A `file.read` response `{type:"binary"}` gives exit 2 with stderr `binary file`.
  - Every "never ran" path (invalid op, unknown tool, client throw) gives exit 2, while an empty result gives exit 1.
  - `experimental.chat.system.transform` is a no-op when the request is a title, summary or small-model prompt. Detect that from `input` per opencode 1.18.32 `session/llm/request.ts:56-72` and `agent/agent.ts:381`, and cite them.
- [ ] **Step 2:** Run the tests and watch them fail.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(opencode): bounded find with explicit truncation, single-instance directory, exit-2 failures`.

### Task 12: pi adapter fixes and version bump

Covers PI-1 through PI-6.

**Files:**
- Modify: `.pi/extension/index.ts`, `package.json` (`devDependencies` → `@earendil-works/pi-coding-agent: ^0.87.1`; add `peerDependencies: {"@earendil-works/pi-coding-agent": "*"}` and `peerDependenciesMeta: {..., optional: true}`, because Claude, Codex and opencode users do not have pi), `pnpm-lock.yaml`
- Create: `__tests__/pi-host.test.ts`, which uses pi's real `loadExtensions()` and `validateToolArguments` from the installed package

- [ ] **Step 1:** Run `pnpm add -D @earendil-works/pi-coding-agent@^0.87.1`, then run the typecheck.
- [ ] **Step 2: Failing tests** in `pi-host.test.ts`:
  - The real loader loads `dist/.pi/extension/index.js` and registers `predexec`.
  - `prepareArguments` followed by `validateToolArguments` accepts `nodes` as a JSON string, a whole-plan string, and `commands:"ls"`.
  - `execute` with an engine `stoppedReason:"error"` **throws**.
  - The tool_result nudge is not appended when `event.isError`, and *is* appended for `powershell`.
  - A tool-op executor throw gives exit 2.
- [ ] **Step 3:** Run the tests and watch them fail.
- [ ] **Step 4: Implement.**
  - Add `prepareArguments: (args) => coercePlan-derived normalization`. Reuse the adapter-runtime coercion so it isn't reimplemented.
  - Throw on error.
  - Add `isError` and `powershell` handling.
  - Use exit 2 for never-ran.
  - Update the matching CLAUDE.md hard-won bullet in Task 23: exit 2 is now uniform across all hosts.
- [ ] **Step 5:** Run `./node_modules/.bin/vitest run __tests__/pi.test.ts __tests__/pi-host.test.ts`. Expected: PASS.
- [ ] **Step 6:** Commit: `fix(pi): coerce via prepareArguments, throw on error, exit-2 failures; bump pi to 0.87`.

### Task 13: Codex policy fidelity

Covers CX-1, CX-2, CX-3, CX-4, CX-6, and CX-7 (the code part).

**Files:**
- Modify: `mcp/policy-codex.ts`, `mcp/toml-lite.ts`
- Test: `__tests__/mcp/policy-codex.test.ts`, `__tests__/mcp/toml-lite.test.ts`

**Interfaces:**
- Produces: `readCodexRules(cwd, opts)` resolves the Codex layers in this order:
  1. system `/etc/codex/rules`
  2. `$CODEX_HOME` (env, else `~/.codex`) `rules/`
  3. for trusted projects, the `.codex/rules/` of every directory from the project root down to cwd

  The project root comes from `project_root_markers` (default `[".git"]`) on canonical realpaths, using the main worktree root when `.git` is a file. Trust is looked up per cwd, then project root, then main worktree root. Use `codex-rs/config/src/loader/mod.rs:1041-1080, 1249-1340, 1378` as the reference and cite it.

- [ ] **Step 1: Failing tests.**
  - A `default.rules` containing `network_rule(...)` and `host_executable(...)` alongside `prefix_rule(pattern=["rm"], decision="forbidden")` → `ls` allowed and `rm x` stopped. Before the fix, both are stopped.
  - A `config.toml` with `[[skills.config]]`, inline tables, `"""` strings, dotted keys, `é`, `1_000`, `1e5`, plus a valid `[projects."/p"] trust_level="trusted"` → trust read correctly.
  - The same file with a *malformed* `[projects.*]` section → fail closed.
  - A duplicate `[a]` header → fail closed.
  - A session in `<trusted repo>/sub/dir`, and one via a symlink to the repo → the repo's `.codex/rules` forbidden rule applies.
  - `/etc/codex/rules/x.rules` forbidding `cat` → stops. Parametrize the system dir through `CodexPolicyOptions.systemDir` for tests.
  - `CODEX_HOME=/tmp/ch` with rules there → honored.
  - Patterns: `[["rm","rmdir"],"-rf"]` matches `rmdir -rf x` but not `ls`, `"a\\b"` matches `a\b`, and `"*"` matches only a literal `*`.
- [ ] **Step 2:** Run the tests and watch them fail.
- [ ] **Step 3: Implement.**
  - **toml-lite:** full parsing for strings, numbers, inline tables, arrays of tables and dotted keys. A parse error *outside* `projects` is tolerated (logged into the result as `warnings`). A parse error that touches `projects` fails closed. Duplicate table headers fail closed.
  - **execpolicy extractor:** skip `network_rule(...)` and `host_executable(...)` call statements, balanced-paren aware. Unknown top-level calls still fail closed.
- [ ] **Step 4:** Run `./node_modules/.bin/vitest run __tests__/mcp`. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(codex): tolerate host-written rules/config, layered trust and rules resolution, CODEX_HOME`.

---

## Phase 4 — Skills everywhere

### Task 14: Single-source skill generation

Covers the SKILL.md requirement, PI (steering), and CC-5.

**Files:**
- Modify: `steering.ts`. Add `SKILL_HARNESSES` and `renderSkill(harness)`.
- Create: `scripts/gen-skills.mjs` (it imports the compiled `dist/steering.js`), and `package.json` script `"skills": "pnpm run build && node scripts/gen-skills.mjs"`
- Generate:
  - `.pi/skills/predexec/SKILL.md` (pi discovers it through `pi.skills`)
  - `skills/claude/predexec/SKILL.md`
  - `skills/codex/predexec/SKILL.md`
  - `skills/opencode/predexec/SKILL.md`
  - `skills/antigravity/predexec/SKILL.md`
- Delete: `skills/predexec-claude/` (replaced by `skills/claude/predexec/`)
- Modify: `.pi/extension/index.ts`. Trim `promptGuidelines` to a pointer ("see the predexec skill") and keep the one-line `promptSnippet`, which pi needs to list the tool. The tool-op syntax moves into the skill.
- Create: `__tests__/skills.test.ts`

**Interfaces:**
- Produces:
  - `type SkillHarness = "pi" | "claude" | "codex" | "opencode" | "antigravity"`
  - `renderSkill(h: SkillHarness): string`, which returns the full file with frontmatter
  - `SKILL_PATHS: Record<SkillHarness, string>`, repo-relative

**Content rules:**
- Every skill has `name: predexec`.
- The `description` is the full routing rule: `STEERING_LINE` plus when to use it.
- The body is composed from the `steering.ts` constants: `USAGE_LINE`, `VERIFY_FIRST_LINE`, `RECOVERY_LINE`, `WHEN_SYNTAX_LINE`, the tool-op syntax, and a per-harness policy paragraph (Claude deny/ask → stop; opencode prompts via host; Codex rules; Antigravity grants). pi omits `policyStop`.
- **Never hardcode an `mcp__…` tool id.** Say "the `predexec` tool (its full id varies by install, e.g. `mcp__predexec__predexec` or a plugin-namespaced id)".
- Skills live in per-harness subtrees so opencode's and Codex's recursive `**/SKILL.md` scans of a plugin's skills dir never pick up another harness's skill.

- [ ] **Step 1: Failing tests** in `skills.test.ts`:
  - For each harness, `readFileSync(SKILL_PATHS[h])` equals `renderSkill(h)`. This is the drift guard. On failure the message should say "run pnpm skills".
  - The frontmatter parses, `name` matches the regex, and `description` is ≤1024 chars and contains the `STEERING_MARKERS` quorum.
  - No skill body contains `mcp__predexec__predexec` except inside the "varies by install" sentence.
  - `package.json.files` includes `skills` and `.pi/skills`.
  - `npm pack --dry-run --json` lists all five `SKILL.md` files. Reuse the pack helper if one exists.
- [ ] **Step 2:** Run the tests and watch them fail.
- [ ] **Step 3:** Implement `renderSkill`, then run `pnpm skills` to generate the files.
- [ ] **Step 4:** Run `./node_modules/.bin/vitest run __tests__/skills.test.ts __tests__/steering.test.ts __tests__/pi.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: generate every harness's routing SKILL.md from steering.ts`.

### Task 15: `predexec install-skill` and doctor skill checks

**Files:**
- Modify: `bin/predexec.mjs`, `README.md`
- Test: `__tests__/doctor.test.ts`, `__tests__/install-skill.test.ts` (new)

**Interfaces:**
- CLI: `predexec install-skill <claude|codex|opencode|antigravity|pi> [--project] [--dry-run]`. It copies the packaged `skills/<h>/predexec/` (or `.pi/skills/predexec`) into the target. It refuses to overwrite a differing existing file unless `--force` is given, and it prints the destination.

| Harness | Global | `--project` |
|---|---|---|
| claude | `${CLAUDE_CONFIG_DIR:-~/.claude}/skills/predexec/` | `.claude/skills/predexec/` |
| codex | `~/.agents/skills/predexec/` | `.agents/skills/predexec/` |
| opencode | `~/.config/opencode/skills/predexec/` | `.opencode/skills/predexec/` |
| antigravity | the path measured in Task 19 | `.agents/skills/predexec/` |
| pi | no-op with a message: pi loads it from the package | — |

- **Doctor:**
  - Per harness, `[x] skill` when a predexec `SKILL.md` exists in any discovery root for that host, or the host's plugin form ships it.
  - `[ ] skill` when the server is registered but no skill is found, with a hint to run `install-skill`.
  - `[!]` when two different predexec skills are visible to one host. Example: opencode sees both `.claude/skills/predexec` and its own.
  - `info` when a Codex/opencode `AGENTS.md` block *and* a skill are both active (the routing text loads twice).
  - Honor `CLAUDE_CONFIG_DIR`.
  - For local-scope Claude registrations, walk up from cwd through its ancestors in `~/.claude.json` `projects` (CC-6).

- [ ] **Step 1:** Write failing tests. Point `HOME` at a tmp dir, run `install-skill` for each harness with and without `--project`, and assert the files. Assert the doctor lines for present, missing and duplicate skills.
- [ ] **Step 2:** Run the tests and watch them fail. **Step 3:** Implement. **Step 4:** Tests pass.
- [ ] **Step 5:** Commit: `feat(cli): install-skill command; doctor verifies skills per harness`.

### Task 16: Claude Code plugin packaging

Covers CC-5 (packaging) and CC-6.

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Modify: `scripts/sync-plugin-version.mjs`, `README.md`
- Test: `__tests__/release-hygiene.test.ts`

- [ ] **Step 1:** Verify the current plugin schema, especially the custom `skills` path field and marketplace `source` forms, against https://code.claude.com/docs/en/plugins-reference and https://code.claude.com/docs/en/plugin-marketplaces. Record the URLs in the commit body.
- [ ] **Step 2: Failing tests:**
  - `plugin.json` has `author`, and `skills: "./skills/claude/"` (or the documented equivalent).
  - Its npx args pin `--package=predexec@<package.json version>`.
  - `marketplace.json` lists the `predexec` plugin with `source: "./"`.
  - After `node scripts/sync-plugin-version.mjs`, both files carry the package version.
  - If the `claude` CLI is on PATH, `claude plugin validate .` exits 0. Otherwise skip that check.
- [ ] **Step 3:** Implement. Document this in the README:

  ```
  /plugin marketplace add FuriousZen/predexec
  /plugin install predexec@predexec
  ```

  Keep `claude mcp add` as the alternative, followed by `npx -y predexec install-skill claude`. Warn not to do both.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit: `feat(claude): installable plugin marketplace with version-pinned server and skill`.

### Task 17: opencode ships its skill via the plugin

**Files:**
- Modify: `.opencode/plugins/predexec.ts`, `configs/opencode/AGENTS.md` (it becomes a manual-install note), `README.md`
- Test: `__tests__/opencode.test.ts`

- [ ] **Step 1: Failing tests:**
  - The plugin's `config` hook appends the absolute path of the packaged `skills/opencode` to `cfg.skills.paths`. It is idempotent and preserves existing paths.
  - The system-transform guard skips injection when the system prompt already lists the predexec skill description. The quorum must hit on the generated description.
- [ ] **Step 2:** Implement. Keep the guarded `system.transform` as a fallback for agents with `tools.skill:false` or `permission.skill` set to deny.
- [ ] **Step 3: Live measurement.** If `opencode` is on PATH, run it in a scratch project that has the plugin installed from `npm pack`, and check that:
  - `opencode debug skill`, or the `<available_skills>` block in a debug-logged prompt, lists `predexec`;
  - the `config` hook runs before skill discovery.

  Record the result in `docs/research/opencode-skills.md`. If the hook ordering fails, fall back to documenting `install-skill opencode`, and have doctor report `[ ] skill`.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit: `feat(opencode): register packaged skill via config hook; system-transform fallback`.

### Task 17a: opencode v2 plugin API support

Added mid-execution by ruling R41. During Task 17's live measurement, the installed opencode v2.0.16 rejected predexec's `{id, server}` plugin export with `PluginModule.LoadError: Missing key ["default"]["effect"]/["default"]["setup"]`. The audit had treated 1.18.32 as latest, so opencode v2 users currently get no predexec at all.

**Files:**
- Modify: `.opencode/plugins/predexec.ts`. It may split into `.opencode/plugins/{v1,v2,shared}.ts` if needed.
- Modify: `package.json` (`main`/`exports` only if a separate v2 entry is required), `__tests__/opencode.test.ts`
- Create: `docs/research/opencode-v2-plugins.md`

**Interfaces:**
- Produces: one default export that loads on BOTH opencode 1.18.x (`{id, server}`) and 2.x (`{id, setup | effect}`). If a single object can't satisfy both loaders' schemas, fall back to separate entries, chosen by whatever mechanism v2 documents for resolving plugin entries.

- [ ] **Step 1: Research.** Get opencode's v2 plugin contract from source. Clone the tag matching the installed binary (`opencode --version`) into the scratchpad and read `@opencode-ai/plugin/v2/{promise,effect}`, `core/config/plugin/external.ts` and the v2 tool/hook/permission APIs. Record the contract with file:line cites in `docs/research/opencode-v2-plugins.md`. It must cover:
  - tool registration and argument schemas (which zod version the host pins)
  - the system-prompt hook, if any
  - the config/skills registration hook
  - the `ask` equivalent for permissions
  - the file/find/grep client API
- [ ] **Step 2: Failing tests.** Mock both loaders' validation: the v1 shape check and a transcription of the v2 schema check. Assert the default export passes both. Assert the v2 `setup` registers the `predexec` tool, the skills path and the steering fallback, and that it wires the permission bridge.
- [ ] **Step 3: Implement.**
  - Put adapter logic behind a shared core so v1 and v2 stay thin shims.
  - Keep every Task 10/11/17 behavior: static-policy pre-check, host ask bridge with variant/stop semantics, exit-2 conventions, truncation flags, realpath containment, and skill registration.
  - If a v2 capability is missing, degrade explicitly and document it. For example, if there is no `ask`, use static policy with a hard stop.
- [ ] **Step 4: Live verification.** Run against the installed v2.0.16 in a scratch project with scratch `HOME`/`XDG_*`. Never touch `~/.config/opencode`. Check that:
  - the plugin loads with no LoadError;
  - the `predexec` tool is listed;
  - one read-only plan runs;
  - the skill is discoverable.

  Record the results in the research doc. Also re-run the v1 path's existing tests.
- [ ] **Step 5:** Full gate, then commit: `feat(opencode): support the v2 plugin API alongside v1`.

### Task 18: Codex plugin + skill packaging

Covers CX-4 (registration) and CX-7 (docs).

**Files:**
- Create:
  - `.codex-plugin/plugin.json`: `{ name, version, description, "mcpServers": "./.codex-plugin/mcp.json", "skills": "./skills/codex/" }`
  - `.codex-plugin/mcp.json`: `{ "mcpServers": { "predexec": { "command": "npx", "args": ["-y","--package=predexec@<ver>","predexec-mcp","--host","codex"], "env_vars": ["CODEX_HOME"] } } }`
  - `.agents/plugins/marketplace.json`
- Modify: `scripts/sync-plugin-version.mjs` (sync these too), `package.json` `files` (add `.codex-plugin`), `configs/codex/AGENTS.md` (strip the preamble into README prose so the file is paste-ready), `README.md` (replace the `curl -o AGENTS.md` clobber with plugin install, `install-skill codex`, and an *append* fallback), `bin/predexec.mjs` doctor (warn when the Codex registration lacks `env_vars=["CODEX_HOME"]` while `CODEX_HOME` is set in the user's shell)
- Modify: `mcp/policy-codex.ts:6,17,133` and `bin/predexec.mjs:684`. Replace the dangling `CODEX-RESEARCH.md` citations with Codex source paths and URLs.

- [ ] **Step 1:** Verify the manifest schema against the installed codex-cli (`codex plugin --help`, and an installed plugin under `~/.codex/plugins` or wherever `codex plugin list` points). Match the key names exactly, especially `mcpServers` path-vs-inline and `env_vars`.
- [ ] **Step 2: Failing tests** in `release-hygiene`:
  - The manifests parse, versions are synced, and `--host codex` and `env_vars` are present.
  - There is no root `.mcp.json`.
  - `npm pack` includes `.codex-plugin/` and `skills/codex/`.
- [ ] **Step 3: Implement.** Then, if `codex` is on PATH, run a live check in a scratch dir:

  ```
  codex plugin marketplace add <repo path>
  codex plugin add predexec
  codex mcp list
  ```

  Record the result in `docs/research/codex-plugin.md`.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit: `feat(codex): plugin with skill and CODEX_HOME forwarding; AGENTS.md becomes fallback`.

---

## Phase 5 — Antigravity

### Task 19: Antigravity live measurements

This is a research task with no production code.

**Files:**
- Create: `docs/research/antigravity.md`, and the probe script `scripts/probes/mcp-env-probe.mjs`, excluded from `files`

- [ ] **Step 1:** Write a stdio MCP probe server with `@modelcontextprotocol/server` and one tool, `probe`, annotated `readOnlyHint:true`. On start it appends a JSON line to `$TMPDIR/predexec-probe.log` recording:
  - `process.cwd()`
  - all env var **names**, plus the values of any `ANTIGRAVITY_*`/`GEMINI_*` vars
  - `process.ppid`
  - whether writing `~/predexec-probe-write-test` succeeds (then delete it)

  Also send one line to stderr.
- [ ] **Step 2:** Register it with `agy mcp add --env PROBE=1 predexec-probe node -- <abs path>/scripts/probes/mcp-env-probe.mjs`. Run `agy` non-interactively in a scratch git repo, using `agy --help` to find the headless/prompt flag, with a prompt that asks it to call the `probe` tool. Then answer and record:
  - (a) the cwd, and whether it equals the workspace root when started from a subdir;
  - (b) whether the call prompted for approval under the default `toolPermission`;
  - (c) whether the write succeeded, which shows whether MCP children run outside the sandbox (also test with `enableTerminalSandbox:true`);
  - (d) which global skills dir is loaded: place a trivial skill in each of `~/.gemini/config/skills/` and `~/.gemini/antigravity-cli/skills/` and ask agy to list its skills;
  - (e) after `agy plugin install` of a scratch plugin wrapping the probe, the namespaced tool name, and whether `mcp(predexec-probe/*)` grants match it.
- [ ] **Step 3:** If a step can't run headless, mark it **UNVERIFIED** with the exact blocker. Do not guess. Afterwards remove the probe registration (`agy mcp remove predexec-probe`) and the scratch skills.
- [ ] **Step 4:** Commit: `docs(research): measure Antigravity MCP spawn, approval, sandbox, skills, plugin namespacing`.

### Task 20: `--host antigravity` + `mcp/policy-antigravity.ts`

**Files:**
- Create: `mcp/policy-antigravity.ts`, `__tests__/mcp/policy-antigravity.test.ts`
- Modify: `bin/predexec-mcp.mjs` (accept `antigravity` in `--host`), `mcp/server.ts` (select the checker and the stats label `antigravity`; the description stays host-neutral), `stats.ts` / `bin/predexec.mjs stats` (the label), tool-op containment root (per the Task 19 cwd finding; if the cwd is not the workspace, add `--root <dir>` / `PREDEXEC_ROOT` and document it)

**Interfaces:**
- Produces:
  - `createAntigravityPolicyChecker(opts: { home?: string; cwd: string; env?: NodeJS.ProcessEnv }): OperationPolicyChecker`
  - `parseAntigravityGrant(s: string): { action: string; target: { kind: "prefix" | "regex" | "any"; value: string } } | null`

**Semantics** (https://antigravity.google/docs/permissions; cite in comments):
- Source: `~/.gemini/antigravity-cli/settings.json` `permissions.{deny,ask,allow}`, plus `toolPermission` and `allowNonWorkspaceAccess`.
- Shell operation → `command(...)` grants:
  - `prefix` matches on a word boundary;
  - `regex:` is compiled only if `isSafeRegex`, otherwise fail closed;
  - a command containing `$(`, a backtick or `<(` needs an exact full-line match (per the docs).
- Tool ops `read`/`grep`/`find`/`ls` → `read_file(...)` grants.
- Order is Deny > Ask > Allow. A deny or ask match is a `policyStop`.
- `toolPermission: "strict"` → stop unless an allow matches. `allowNonWorkspaceAccess: false` → stop any op whose path resolves outside the workspace.
- A missing file means no rules. An unparseable file, or an unknown grant syntax in deny/ask, fails closed. Unknown syntax in allow is ignored, because ignoring an allow can only add stops.
- App/IDE UI grants are unreadable: document that as a known gap.

- [ ] **Step 1: Failing tests.**
  - Deny beats allow, ask stops, and a prefix word boundary means `command(git)` matches `git status` but not `gitk`.
  - An unsafe `regex:` fails closed. A substitution construct requires an exact match.
  - `read_file` deny applies to tool ops.
  - `strict` behaves as specified, and so does `allowNonWorkspaceAccess:false`.
  - Unparseable JSON fails closed. A missing file allows.
  - `--host antigravity` selects the checker, as seen in stdio server tests. Mirror the existing `--host codex` test.
  - An invalid `--host` still errors to stderr.
- [ ] **Step 2:** Run the tests and watch them fail. **Step 3:** Implement. **Step 4:** `./node_modules/.bin/vitest run __tests__/mcp` passes.
- [ ] **Step 5:** Commit: `feat(antigravity): --host antigravity with Deny>Ask>Allow grant policy`.

### Task 21: Antigravity plugin, skill install, and doctor

**Files:**
- Create:
  - `antigravity-plugin/plugin.json`: `{"name":"predexec", ...}`, per the Task 19 findings and `agy plugin validate`
  - `antigravity-plugin/mcp_config.json`: `{"mcpServers":{"predexec":{"command":"npx","args":["-y","--package=predexec@<ver>","predexec-mcp","--host","antigravity"]}}}`
  - `antigravity-plugin/skills/predexec/SKILL.md`. Generate this from `renderSkill("antigravity")`: extend `SKILL_PATHS` so the antigravity skill is written here instead of `skills/antigravity/`, and delete that dir.
  - `configs/antigravity/AGENTS.md` (paste-ready fallback)
- Modify: `scripts/sync-plugin-version.mjs`, `package.json` `files`, `bin/predexec.mjs` (doctor + `install-skill antigravity`), `README.md`

**Doctor checks:**
- `[-]` when neither `agy` nor `~/.gemini` exists.
- `[x]` when predexec is registered, either in `~/.gemini/config/mcp_config.json` with `--host antigravity` or as an enabled plugin under `~/.gemini/config/plugins/`.
- `[!]` when it is registered without `--host antigravity`.
- `[!]` when the plugin is disabled in `~/.gemini/config/config.json`.
- The skill is present in a Task 19-verified path.
- `info` when there is no `mcp(predexec/*)` allow grant (every call will prompt), unless Task 19 showed `readOnlyHint` suppresses prompting.

- [ ] **Step 1:** Write failing tests covering doctor fixtures for each state above, the manifest and version sync, and that `npm pack` includes `antigravity-plugin/`.
- [ ] **Step 2:** Implement. If `agy` is on PATH, run `agy plugin validate antigravity-plugin`. It must exit 0.
- [ ] **Step 3:** Document the install in the README:

  ```
  npx -y --package=predexec@<ver> predexec … # or
  agy plugin install <path to node_modules/predexec/antigravity-plugin>
  ```

  Also document the manual fallback, `agy mcp add predexec npx -- -y --package=predexec predexec-mcp --host antigravity`, followed by `npx -y predexec install-skill antigravity`.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit: `feat(antigravity): plugin bundle with skill; doctor and install-skill support`.

---

## Phase 6 — Dependencies and docs

### Task 22: Dependency refresh

Covers DEP-1.

**Files:** `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1:** Run `pnpm update @modelcontextprotocol/server zod` within their existing ranges. The lock should reach MCP server 2.1.x (for the id-0 cancellation fix) and the latest zod 4.x.
- [ ] **Step 2:** Add a test in `__tests__/mcp/server.test.ts`. A `notifications/cancelled` for request id `0` must abort the running plan, observed as `stoppedReason` "aborted" or equivalent in the result.
- [ ] **Step 3:** Run the full gate, and `pnpm audit --prod`. Expected: PASS and no vulnerabilities. `pnpm ls --prod --depth Infinity` must still list only the 3 packages.
- [ ] **Step 4:** Commit: `chore(deps): MCP server 2.1, zod 4.x refresh`.

Deferred, not in this plan: TypeScript 7 and Vitest 5 (major bumps; each needs its own plan), and the opencode v2 plugin API (not wired into the host session path as of 1.18.32; watch item).

### Task 23: Documentation truth pass

Covers DOC-1 and the stale claims.

**Files:** `/Users/williamwo/Development/personal/predexec/CLAUDE.md` (outside the repo; edit in place, not committed), `README.md`, `steering.ts` header comment

- [ ] **Step 1:** Update CLAUDE.md:
  - Layout: add `core/shell/*`, `plan-language.ts`, `core/validation.ts`, `mcp/toml-lite.ts`, `mcp/gitignore-match.ts`, `mcp/policy-antigravity.ts`, `skills/<h>/predexec/`, `.codex-plugin/`, `antigravity-plugin/`, `docs/`, `scripts/gen-skills.mjs`.
  - Test count: the actual number from the final run.
  - Five adapters.
  - Replace "exit 2 only on CC" with "exit 2 for never-ran on every host".
  - Replace the CODEX_HOME env claim with the `env_vars` finding.
  - Rewrite the zod-skew rationale: host pnpm re-resolves; narrowing can't match opencode's 4.1.8; the MCP SDK carries its own copy.
  - Update "Tool ops bypass non-bash permissions" to its post-Task 9/10/20 state per host.
  - Add a "skills are generated — run `pnpm skills`" hard-won bullet.
  - Add the opencode `context.ask` behavior.
  - Add the Antigravity gaps measured in Task 19.
- [ ] **Step 2:** README: a per-harness install matrix (plugin path / manual path / skill step) for all five hosts, and the `install-skill` and `doctor` usage.
- [ ] **Step 3:** Run the full gate, `npm pack --dry-run`, and `node bin/predexec.mjs doctor`, and paste the summary into the final report.
- [ ] **Step 4:** Commit (repo files only): `docs: five-harness install matrix and skill workflow`.

---

## Execution order and dependencies

`0 → 1 → 2 → 3 → 4 → 5 → 6 → 7`, then `8, 9, 10, 11, 12, 13`, which are independent of each other but depend on 5 and 7. Then `14 → 15 → 16, 17, 18`, then `19 → 20 → 21`, then `22 → 23`. Run tasks one at a time, because every task touches shared files (`core/index.ts`, `bin/predexec.mjs`, `package.json`).
