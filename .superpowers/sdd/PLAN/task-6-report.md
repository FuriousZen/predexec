# Task 6 RED/GREEN Report

## Scope

Task 6 makes the MCP pure-Node fallback termination-safe and bounded while
preserving the existing read/grep/find output, continuation, and exit-code
contracts. Work started from `bd04f4bebb63496f63083461c164503b6f14689c`.

Changed files:

- `core/index.ts`
- `mcp/tool-ops.ts`
- `__tests__/mcp/tool-ops.test.ts`

The progress ledger ruling was followed: no production export was added solely
to expose retained-line memory. The tests use real temporary files; bounded
storage is inspected at source level below.

## RED

Added behavior tests before implementation:

1. The public-barrel helper test called `isSafeRegex("(a+)+$")` and expected
   `false`; before the change it failed with `TypeError: isSafeRegex is not a
   function`.
2. The node-only fallback test searched a real temporary text file with
   `(a+)+$`; before screening it returned exit code `0` instead of the required
   search-not-run exit code `2` and did not report `unsafe pattern`.
3. Added real temporary-file tests for sorted fallback matches beyond
   `limit: 3`, the limit warning, and a 12,000-line read with
   `{offset: 2, limit: 2}` and byte-exact continuation text. These documented
   the required output contract while the implementation still used whole-file
   reads.

Focused RED command:

```text
./node_modules/.bin/vitest run __tests__/mcp/tool-ops.test.ts
```

Observed: `79 tests | 2 failed`; the two failures were the missing public
`isSafeRegex` export and the fallback unsafe-regex exit-code assertion. The
remaining existing tests passed.

## GREEN

Implementation:

- Re-exported the existing pure-core `isSafeRegex` through `core/index.ts`.
- Screened non-literal fallback patterns before `new RegExp`, returning the
  existing grep failure shape with exit code `2` and an actionable unsafe
  pattern message.
- Added a `createReadStream` + `node:readline` scanner. It tracks only byte/NUL
  state, line counters, and the final-newline bit; callers retain requested
  lines only. This preserves one-based offsets, line totals, final-newline
  output, binary refusal, and continuation notices.
- Sorted fallback candidate paths before scanning and stopped each scan after
  collecting `limit + 1` matches. Only the first `limit` are formatted, so the
  existing warning and exit code behavior remain unchanged.
- Converted context formatting from `readFile(...).split("\\n")` to the same
  streaming scanner, retaining only context lines around returned matches.

Focused GREEN command and result:

```text
./node_modules/.bin/vitest run __tests__/mcp/tool-ops.test.ts
```

`1` test file passed, `79/79` tests passed.

## Verification

```text
./node_modules/.bin/tsc --noEmit
```

Passed.

```text
./node_modules/.bin/tsc -p tsconfig.build.json
```

Passed.

```text
./node_modules/.bin/vitest run
```

Passed: `19` test files, `689/689` tests.

```text
git diff --check
```

Passed with no whitespace errors.

## Bounded-collection inspection

- `scanTextLines` in `mcp/tool-ops.ts` retains no complete-file string or line
  array; it keeps counters, final-byte/NUL state, and invokes a caller callback
  per line.
- `readOp` appends only lines within the requested offset/limit window, plus a
  synthetic empty terminal line when needed for final-newline parity.
- Fallback grep keeps a `pending` collection for one file and the global
  `matches` collection. Both are bounded by the requested limit plus one; the
  scan is stopped as soon as that fourth match (for limit three) is observed.
- Context formatting caches only line-number/text pairs intersecting the
  requested context windows for returned matches. It does not retain the whole
  source file.
- Candidate paths are the only intentionally bounded walk collection and retain
  the existing `MAX_WALK_FILES` cap.

## Concerns / residual risk

- The ledger intentionally disallows a production memory probe, so the
  retained-line bound is established by implementation inspection and real
  large-file output tests rather than RSS or an instrumentation assertion.
- `rg` still materializes its subprocess stdout and parsed matches up to the
  existing 16 MiB `maxBuffer` before formatting; Task 6's bounded scan contract
  applies to the pure-Node fallback, while the accelerator path remains
  behavior-compatible.
- The existing `isSafeRegex` policy remains best-effort and narrow by design;
  it rejects nested open-ended quantifier groups such as `(a+)+` but does not
  claim to prove all JavaScript regexes terminate quickly.
