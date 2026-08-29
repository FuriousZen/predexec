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

## Fix round 1/5

### RED regressions

Added four regressions before the fix:

- `^$` must match an empty file and the synthetic terminal empty line created
  by the old `split("\\n")` implementation.
- LF-only splitting must preserve `\\r` in CRLF and bare-CR text, including
  read output and grep line text.
- A binary NUL arriving after the fourth match must still cause the complete
  file to be refused, even though match processing has stopped at
  `limit + 1`.
- An already-aborted read must report its read failure, while an aborted grep
  must retain the search-not-run exit code `2` and report `aborted`.

Before the fix:

```text
./node_modules/.bin/vitest run __tests__/mcp/tool-ops.test.ts
```

`83 tests | 3 failed`: synthetic empty-line search, CR preservation, and
aborted read. The binary regression initially used a tiny file and passed
because the NUL shared the first stream chunk; it was strengthened to place the
NUL after 128 KiB, in a later chunk, before implementation work continued.

### GREEN implementation

- Replaced `node:readline` with an LF-only incremental splitter driven by
  `createReadStream` and `StringDecoder`. It preserves carriage returns,
  counts the terminal empty line for empty/final-LF files, and emits the same
  one-based line sequence as `Buffer.toString("utf8").split("\\n")`.
- Match callbacks are disabled after `limit + 1`, but the stream continues
  through every remaining chunk with only the line buffer/counters and NUL
  flag retained. A binary file therefore cannot become a successful match
  merely because its NUL occurs after the match cap.
- Passed `AbortSignal` into read, grep, and context scans and into
  `createReadStream({signal})`. Abort errors are rethrown instead of being
  mistaken for unreadable files; executor classification consequently remains
  read exit `1` and grep exit `2`.
- Synthetic terminal-line handling now lives in the shared scanner, so read,
  grep, and context formatting all receive the same LF-split semantics.

Fix-round focused GREEN command:

```text
./node_modules/.bin/vitest run __tests__/mcp/tool-ops.test.ts
```

Passed: `1` file, `83/83` tests.

### Fix-round self-review

- The scanner's retained match state remains bounded: pending/current-file and
  global match collections stop at `limit + 1`; continuing for binary detection
  does not retain later line text.
- The scanner's unfinished line buffer can be as large as one physical line,
  which is required to evaluate that line and is the same unavoidable unit of
  retention for a line-oriented search. No complete-file array/string is built.
- The context cache still scales with requested context and returned matches;
  this is a pre-existing output requirement and remains a minor ledger
  concern rather than an unrelated scope expansion.
- `rg` behavior remains unchanged; these signal and LF-splitting corrections
  apply to the pure-Node path that owns the fallback bounded-read contract.

### Fix-round verification

```text
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p tsconfig.build.json
./node_modules/.bin/vitest run
git diff --check
```

All passed after the fix round: full suite `19` files / `693` tests, typecheck,
build, and whitespace check.
