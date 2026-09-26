import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  isSafeRegex,
  MAX_FIND_RESULTS,
  MAX_GREP_CONTEXT,
  MAX_GREP_RESULTS,
  MAX_LS_ENTRIES,
  MAX_READ_LINES,
  MAX_GREP_PATTERN_LENGTH,
  type ToolOp,
} from "../../core/index.ts";
import {
  createToolExecutor,
  findOnPath,
  globToRegExp,
  GREP_OP_TIMEOUT_MS,
  lsOp,
  runBinary,
  walkFiles,
  type LsDirectoryLike,
  type LsOpendirLike,
  type ExecFileLike,
  type ToolExecutorOptions,
} from "../../mcp/tool-ops.ts";

// A real tree on disk: these ops are node:fs all the way down, so mocking the
// filesystem would only test the mock. The temp dir is deliberately NOT a git
// repo — rg/fd apply .gitignore only inside one, which keeps the accelerated
// and fallback file sets comparable in the parity tests below.
const root = mkdtempSync(join(tmpdir(), "px-toolops-"));
const outside = mkdtempSync(join(tmpdir(), "px-outside-"));
const symlinkRoot = mkdtempSync(join(tmpdir(), "px-symlink-root-"));
// CC-1 regression roots: the top-level `node_modules` entry ITSELF is a
// symlink outside the session root — the shape a committed `node_modules ->
// /` or `-> ..` would take. These must be refused just as completely as the
// sub-symlink case above; no realpath outside the root gets a pass.
const evilNodeModulesRoot = mkdtempSync(join(tmpdir(), "px-evil-node-modules-"));
const parentNodeModulesRoot = mkdtempSync(join(tmpdir(), "px-parent-node-modules-"));
const parentSiblingSecret = join(dirname(parentNodeModulesRoot), "px-parent-sibling-secret.txt");

const write = (rel: string, content: string | Buffer): void => {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

write("a.txt", "alpha\nbeta\ngamma\n");
write(".hidden.txt", "alpha hidden\n");
write("bin.dat", Buffer.from([0x68, 0x69, 0x00, 0x01]));
write("sub/b.ts", "alpha two\nconst x = 1\n");
write("sub/nested/c.ts", "gamma three\n");
write("node_modules/ignored.ts", "alpha ignored\n");
write("many.txt", Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"));
mkdirSync(join(root, "emptydir"));
writeFileSync(join(outside, "secret.txt"), "top secret\n");

let symlinksAvailable = false;
try {
  symlinkSync(outside, join(symlinkRoot, "link"), "junction");
  mkdirSync(join(symlinkRoot, "node_modules"));
  mkdirSync(join(outside, "pkg"));
  writeFileSync(join(outside, "pkg", "package.json"), '{"name":"outside-package"}\n');
  // A symlink placed under a REAL node_modules directory pointing outside the
  // root — this is the removed exemption's attack shape (CC-1): a plan author
  // could plant `node_modules/<anything>` to escape containment.
  symlinkSync(join(outside, "pkg"), join(symlinkRoot, "node_modules", "pkg"), "junction");
  // The legitimate case the removed exemption used to (over-broadly) cover:
  // pnpm's own virtual store layout, `.pnpm/<pkg>/node_modules/<name>` symlinked
  // relatively to `../../<pkg>` — every hop stays lexically inside node_modules,
  // so it needs no exemption at all; plain root containment already allows it.
  mkdirSync(join(symlinkRoot, "node_modules", ".pnpm", "x", "node_modules"), { recursive: true });
  writeFileSync(join(symlinkRoot, "node_modules", ".pnpm", "x", "package.json"), '{"name":"pnpm-style"}\n');
  symlinkSync("../../x", join(symlinkRoot, "node_modules", ".pnpm", "x", "node_modules", "pkg"), "junction");
  // Top-level `node_modules -> outside`: the whole entry is a symlink, not a
  // sub-path under a real directory.
  symlinkSync(outside, join(evilNodeModulesRoot, "node_modules"), "junction");
  // `node_modules -> ..`: resolves to this root's OWN parent directory — a
  // plausible, minimal escape that needs no cooperating "outside" fixture at
  // all, since every session root already has a parent.
  symlinkSync("..", join(parentNodeModulesRoot, "node_modules"), "junction");
  writeFileSync(parentSiblingSecret, "parent sibling secret\n");
  symlinksAvailable = true;
} catch {
  // Some platforms require elevated privileges for symlink creation.
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(symlinkRoot, { recursive: true, force: true });
  rmSync(evilNodeModulesRoot, { recursive: true, force: true });
  rmSync(parentNodeModulesRoot, { recursive: true, force: true });
  rmSync(parentSiblingSecret, { force: true });
});

// R26: some environments (root, certain sandboxes) ignore chmod-based deny —
// probe once rather than assume.
let permissionDenialWorks = false;
try {
  const probe = join(root, ".permission-probe");
  writeFileSync(probe, "x");
  chmodSync(probe, 0o000);
  try {
    readFileSync(probe);
  } catch {
    permissionDenialWorks = true;
  }
  chmodSync(probe, 0o644);
  rmSync(probe, { force: true });
} catch {
  // ignore — permissionDenialWorks stays false
}

/** Forces the pure-Node path regardless of what is installed on this machine. */
const NODE_ONLY: Partial<ToolExecutorOptions> = { rgPath: null, fdPath: null };

const run = (op: ToolOp, over: Partial<ToolExecutorOptions> = {}, cwd = root) =>
  createToolExecutor({ cwd: root, ...over })(op, { cwd });
const runSymlink = (op: ToolOp) => createToolExecutor({ cwd: symlinkRoot })(op, { cwd: symlinkRoot });

const hasRg = findOnPath("rg") !== null;
const hasFd = findOnPath("fd") !== null;

describe("mcp tool-ops — read", () => {
  it("accepts exact shared ceilings and rejects over-ceiling direct calls", async () => {
    const exact = [
      [{ tool: "read", path: "a.txt", limit: MAX_READ_LINES }, ""],
      [{ tool: "grep", path: "a.txt", pattern: "alpha", limit: MAX_GREP_RESULTS }, ""],
      [{ tool: "find", pattern: "*.txt", limit: MAX_FIND_RESULTS }, ""],
      [{ tool: "ls", limit: MAX_LS_ENTRIES }, ""],
      [{ tool: "grep", path: "a.txt", pattern: "alpha", context: MAX_GREP_CONTEXT }, ""],
    ] as const;
    for (const [operation] of exact) expect((await run(operation as ToolOp)).exitCode).not.toBe(1);

    const over = [
      { tool: "read", path: "a.txt", limit: MAX_READ_LINES + 1 },
      { tool: "grep", pattern: "alpha", limit: MAX_GREP_RESULTS + 1 },
      { tool: "find", pattern: "*.txt", limit: MAX_FIND_RESULTS + 1 },
      { tool: "ls", limit: MAX_LS_ENTRIES + 1 },
      { tool: "grep", pattern: "alpha", context: MAX_GREP_CONTEXT + 1 },
      { tool: "grep", pattern: "x".repeat(MAX_GREP_PATTERN_LENGTH + 1) },
    ];
    for (const operation of over) {
      const result = await run(operation);
      expect(result.exitCode).toBeGreaterThan(0);
      expect(result.stderr).toMatch(/at most|maximum length/);
    }
  });

  it("enforces the shared grep pattern ceiling before either search path", async () => {
    const exact = await run({ tool: "grep", pattern: "x".repeat(MAX_GREP_PATTERN_LENGTH) }, NODE_ONLY);
    expect(exact.stderr).not.toContain("maximum length");
    const over = await run({ tool: "grep", pattern: "x".repeat(MAX_GREP_PATTERN_LENGTH + 1) }, NODE_ONLY);
    expect(over.exitCode).toBe(2);
    expect(over.stderr).toContain(`maximum length of ${MAX_GREP_PATTERN_LENGTH}`);
  });

  it("returns the whole file on stdout with exit 0", async () => {
    const r = await run({ tool: "read", path: "a.txt" });
    expect(r).toEqual({ stdout: "alpha\nbeta\ngamma\n", stderr: "", exitCode: 0 });
  });

  it("resolves a path against the op cwd, not just the root", async () => {
    const r = await run({ tool: "read", path: "b.ts" }, {}, join(root, "sub"));
    expect(r.stdout).toBe("alpha two\nconst x = 1\n");
  });

  it("applies offset/limit (offset is 1-based) and announces the shortfall", async () => {
    const r = await run({ tool: "read", path: "a.txt", offset: 2, limit: 1 });
    expect(r.stdout).toBe("beta");
    expect(r.exitCode).toBe(0);
    // A caller-supplied limit that stops short of EOF is still truncation.
    expect(r.stderr).toContain("showing lines 2-2 of 4");
    expect(r.stderr).toContain("use offset=3 to continue");
    expect(r.stdoutTruncated).toBe(true);
  });

  it("reads to EOF silently when limit covers the file", async () => {
    const r = await run({ tool: "read", path: "a.txt", offset: 3, limit: 50 });
    expect(r.stdout).toBe("gamma\n");
    expect(r.stderr).toBe("");
  });

  it("rejects an offset past EOF instead of returning empty stdout", async () => {
    const r = await run({ tool: "read", path: "a.txt", offset: 99 });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("offset 99 is past the end of a.txt (4 lines)");
    expect(r.stdout).toBe("");
  });

  it("reports a missing path with the base it resolved against", async () => {
    const r = await run({ tool: "read", path: "nope.txt" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("read: path not found: nope.txt");
    expect(r.stderr).toContain(root);
  });

  it("refuses a directory and points at ls", async () => {
    const r = await run({ tool: "read", path: "sub" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('is a directory — use {tool:"ls"}');
  });

  it("refuses a binary file rather than dumping bytes into the transcript", async () => {
    const r = await run({ tool: "read", path: "bin.dat" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("looks like a binary file");
  });

  it("caps a long file at the default line budget and says so", async () => {
    const r = await run({ tool: "read", path: "many.txt", limit: 3 });
    expect(r.stdout).toBe("line 1\nline 2\nline 3");
    expect(r.stderr).toContain("showing lines 1-3 of 20");
  });
});

describe("mcp tool-ops — path containment", () => {
  it("rejects a relative path that climbs out of the root", async () => {
    const r = await run({ tool: "read", path: "../secret.txt" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("outside the predexec root");
    expect(r.stdout).toBe("");
  });

  it("rejects an absolute path outside the root", async () => {
    const r = await run({ tool: "read", path: join(outside, "secret.txt") });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("refusing to read outside the session root");
  });

  it("accepts an absolute path inside the root", async () => {
    const r = await run({ tool: "read", path: join(root, "a.txt") });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("alpha\nbeta\ngamma\n");
  });

  it("does not let a sibling directory with the root as a prefix pass", async () => {
    // `${root}-evil` starts with `${root}` — a naive prefix check would allow it.
    const r = await run({ tool: "read", path: `${root}-evil/a.txt` });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("outside the predexec root");
  });

  it("rejects an escaping op cwd by name, not as a missing path", async () => {
    // The engine folds plan.cwd into RunOptions.cwd, so a plan pointing its cwd
    // out of the session arrives here as an escaping base.
    const r = await run({ tool: "ls" }, {}, outside);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("a plan's cwd may not escape the session root");
  });

  it("rejects escaping paths for every op, not just read", async () => {
    // Every op reports 2, not 1: an escaping path never ran anything, and
    // exit 1 is reserved for "ran, found nothing".
    for (const [op, exit] of [
      [{ tool: "ls", path: ".." }, 2],
      [{ tool: "grep", pattern: "alpha", path: ".." }, 2],
      [{ tool: "find", pattern: "*.ts", path: ".." }, 2],
    ] as [ToolOp, number][]) {
      const r = await run(op);
      expect(r.exitCode, op.tool).toBe(exit);
      expect(r.stderr, op.tool).toContain("outside the predexec root");
    }
  });

  it.skipIf(!symlinksAvailable)("rejects a symlink that resolves outside the root for read, grep, and ls", async () => {
    for (const op of [
      { tool: "read", path: "link/secret.txt" },
      { tool: "grep", pattern: "top secret", path: "link" },
      { tool: "ls", path: "link" },
    ] as ToolOp[]) {
      const r = await runSymlink(op);
      expect(r.stderr, op.tool).toContain("symlink resolves outside the predexec root");
    }
  });

  it.skipIf(!symlinksAvailable)(
    "refuses a node_modules symlink that resolves outside the root (CC-1: exemption removed)",
    async () => {
      // Every op reports 2 for "never ran" (see NEVER_RAN_EXIT in
      // mcp/tool-ops.ts); 1 is reserved for "ran, found nothing".
      for (const [op, exitCode] of [
        [{ tool: "read", path: "node_modules/pkg/package.json" }, 2],
        [{ tool: "grep", pattern: "outside-package", path: "node_modules/pkg" }, 2],
        [{ tool: "find", pattern: "*.json", path: "node_modules/pkg" }, 2],
      ] as [ToolOp, number][]) {
        const r = await runSymlink(op);
        expect(r.exitCode, op.tool).toBe(exitCode);
        expect(r.stderr, op.tool).toContain("outside");
      }
    },
  );

  it.skipIf(!symlinksAvailable)(
    "still reads through a pnpm-style relative symlink that stays inside the root",
    async () => {
      const r = await runSymlink({ tool: "read", path: "node_modules/.pnpm/x/node_modules/pkg/package.json" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('{"name":"pnpm-style"}\n');
    },
  );

  it.skipIf(!symlinksAvailable)(
    "refuses a TOP-LEVEL node_modules that is itself a symlink outside the root (CC-1: no exceptions)",
    async () => {
      // The shape a committed `node_modules -> /somewhere/else` would take —
      // not a sub-symlink under a real node_modules directory, the whole
      // entry. Any special-case keyed on "what node_modules itself resolves
      // to" reopens CC-1 exactly this way.
      const executor = createToolExecutor({ cwd: evilNodeModulesRoot });
      const runEvil = (op: ToolOp) => executor(op, { cwd: evilNodeModulesRoot });
      for (const [op, exitCode] of [
        [{ tool: "read", path: "node_modules/secret.txt" }, 2],
        [{ tool: "ls", path: "node_modules" }, 2],
        [{ tool: "grep", pattern: "secret", path: "node_modules" }, 2],
        [{ tool: "find", pattern: "*.txt", path: "node_modules" }, 2],
      ] as [ToolOp, number][]) {
        const r = await runEvil(op);
        expect(r.exitCode, op.tool).toBe(exitCode);
        expect(r.stderr, op.tool).toContain("outside");
      }
    },
  );

  it.skipIf(!symlinksAvailable)("refuses node_modules -> .. (parent-directory escape)", async () => {
    const r = await createToolExecutor({ cwd: parentNodeModulesRoot })(
      { tool: "read", path: "node_modules/px-parent-sibling-secret.txt" },
      { cwd: parentNodeModulesRoot },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("outside");
    expect(r.stdout).toBe("");
  });

  it.skipIf(!symlinksAvailable)("uses the canonical match file for context after a lexical alias is swapped", async () => {
    const contextRoot = mkdtempSync(join(tmpdir(), "px-context-root-"));
    const inside = join(contextRoot, "inside");
    const alias = join(contextRoot, "alias");
    const outsideContext = join(outside, "context-target");
    const fakeRg = join(contextRoot, "fake-rg.cjs");
    mkdirSync(inside);
    mkdirSync(outsideContext, { recursive: true });
    writeFileSync(join(inside, "target.txt"), "inside-before\nhit\ninside-after\n");
    writeFileSync(join(outsideContext, "target.txt"), "outside-before\nhit\noutside-after\n");
    symlinkSync(inside, alias, "junction");
    writeFileSync(
      fakeRg,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const scope = args.at(-1);
process.stdout.write(path.join(scope, "target.txt") + "\\0" + "2:hit\\n");
fs.unlinkSync(${JSON.stringify(alias)});
fs.symlinkSync(${JSON.stringify(outsideContext)}, ${JSON.stringify(alias)}, "junction");
`,
    );
    chmodSync(fakeRg, 0o755);
    try {
      const executor = createToolExecutor({ cwd: contextRoot, rgPath: fakeRg, fdPath: null });
      const r = await executor(
        { tool: "grep", pattern: "hit", path: "alias", context: 1 },
        { cwd: contextRoot },
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("alias/target.txt-1-inside-before\nalias/target.txt:2:hit\nalias/target.txt-3-inside-after");
    } finally {
      rmSync(contextRoot, { recursive: true, force: true });
      rmSync(outsideContext, { recursive: true, force: true });
    }
  });

  it("rejects an accelerator find result outside the validated search scope", async () => {
    const fakeFd = join(symlinkRoot, "fake-fd.cjs");
    writeFileSync(
      fakeFd,
      `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(join(outside, "secret.txt"))} + "\\n");
`,
    );
    chmodSync(fakeFd, 0o755);
    const executor = createToolExecutor({ cwd: root, rgPath: null, fdPath: fakeFd });
    const r = await executor({ tool: "find", pattern: "*.txt" }, { cwd: root });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("find result escaped its validated target");
  });
});

describe("mcp tool-ops — ls", () => {
  it("lists a directory sorted, dotfiles included, dirs slash-suffixed", async () => {
    const r = await run({ tool: "ls" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split("\n")).toEqual([
      ".hidden.txt",
      "a.txt",
      "bin.dat",
      "emptydir/",
      "many.txt",
      "node_modules/",
      "sub/",
    ]);
  });

  it("lists a subdirectory by path", async () => {
    const r = await run({ tool: "ls", path: "sub" });
    expect(r.stdout.split("\n")).toEqual(["b.ts", "nested/"]);
  });

  it("returns exit 0 for an empty directory — empty is a fact, not a failure", async () => {
    const r = await run({ tool: "ls", path: "emptydir" });
    expect(r).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  it("caps at limit and announces the cap", async () => {
    const r = await run({ tool: "ls", limit: 2 });
    expect(r.stdout.split("\n")).toEqual([".hidden.txt", "a.txt"]);
    expect(r.stderr).toContain("2 entry limit reached");
    expect(r.stdoutTruncated).toBe(true);
  });

  it("stops an in-flight enumeration on abort and closes the iterator", async () => {
    const controller = new AbortController();
    let nextCalls = 0;
    let returnCalls = 0;
    let closeCalls = 0;
    const directory: LsDirectoryLike = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            nextCalls += 1;
            if (nextCalls === 1) {
              controller.abort();
              return { value: { name: "first.txt", isDirectory: () => false, isSymbolicLink: () => false }, done: false };
            }
            throw new Error("enumeration continued after abort");
          },
          return: async () => {
            returnCalls += 1;
            return { value: undefined, done: true };
          },
        };
      },
      close: async () => {
        closeCalls += 1;
      },
    };
    const opendir: LsOpendirLike = async () => directory;
    const executor = createToolExecutor({ cwd: root, lsOpendir: opendir });

    const result = await executor({ tool: "ls" }, { cwd: root, signal: controller.signal });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("aborted");
    expect(nextCalls).toBe(1);
    expect(returnCalls).toBe(1);
    expect(closeCalls).toBe(1);
  });

  it("reports an incomplete scan cap while retaining the smallest scanned entries", async () => {
    const entries = ["z-last.txt", "a-first.txt", "m-unseen.txt"].map((name) => ({
      name,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    }));
    const directory: LsDirectoryLike = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          next: async () => ({ value: entries[index++], done: index > entries.length }),
          return: async () => ({ value: undefined, done: true }),
        };
      },
      close: async () => undefined,
    };
    const opendir: LsOpendirLike = async () => directory;

    const result = await lsOp({ tool: "ls", limit: 1 }, root, root, undefined, { opendir, maxScanEntries: 2 });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a-first.txt");
    expect(result.stderr).toContain("incomplete");
    expect(result.stdoutTruncated).toBe(true);
  });

  it("reports a missing directory", async () => {
    const r = await run({ tool: "ls", path: "nope" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("ls: path not found: nope");
  });

  it("refuses a file and points at read", async () => {
    const r = await run({ tool: "ls", path: "a.txt" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('is not a directory — use {tool:"read"}');
  });
});

// Every grep/find behaviour is asserted twice: once as configured on this
// machine, once with the accelerators pinned off. The pair is the point — a
// fallback that merely "does not crash" can still return a different file set,
// and a plan whose edges branch on the count would then branch per-machine.
describe.each([
  ["accelerated", {} as Partial<ToolExecutorOptions>],
  ["node-only", NODE_ONLY],
])("mcp tool-ops — grep (%s)", (mode, over) => {
  const grep = (op: Omit<ToolOp, "tool">) => run({ tool: "grep", ...op }, over);

  it("formats matches as path:line:text, sorted", async () => {
    const r = await grep({ pattern: "alpha" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split("\n")).toEqual([
      ".hidden.txt:1:alpha hidden",
      "a.txt:1:alpha",
      "sub/b.ts:1:alpha two",
    ]);
  });

  it("never searches node_modules", async () => {
    const r = await grep({ pattern: "alpha" });
    expect(r.stdout).not.toContain("node_modules");
  });

  it("no matches => empty stdout, exit 1", async () => {
    const r = await grep({ pattern: "zzz-nothing-here" });
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(1);
  });

  it("scopes to a directory path", async () => {
    const r = await grep({ pattern: "alpha", path: "sub" });
    expect(r.stdout).toBe("sub/b.ts:1:alpha two");
  });

  it("scopes to a single file path", async () => {
    const r = await grep({ pattern: "alpha", path: "a.txt" });
    expect(r.stdout).toBe("a.txt:1:alpha");
  });

  it("honours ignoreCase", async () => {
    expect((await grep({ pattern: "ALPHA" })).exitCode).toBe(1);
    expect((await grep({ pattern: "ALPHA", ignoreCase: true })).exitCode).toBe(0);
  });

  it("honours literal, so regex metacharacters match themselves", async () => {
    expect((await grep({ pattern: "a.pha", literal: true })).exitCode).toBe(1);
    expect((await grep({ pattern: "a.pha" })).exitCode).toBe(0);
  });

  it("honours glob", async () => {
    const r = await grep({ pattern: "alpha", glob: "*.ts" });
    expect(r.stdout).toBe("sub/b.ts:1:alpha two");
  });

  it("renders context blocks with rg's :/- convention", async () => {
    const r = await grep({ pattern: "const", context: 1 });
    expect(r.stdout.split("\n")).toEqual([
      "sub/b.ts-1-alpha two",
      "sub/b.ts:2:const x = 1",
      "sub/b.ts-3-",
    ]);
  });

  it("caps at limit and announces the cap on stderr, never in stdout", async () => {
    const r = await grep({ pattern: "alpha", limit: 1 });
    expect(r.stdout).toBe(".hidden.txt:1:alpha hidden");
    expect(r.stderr).toContain("1 match limit reached");
    // Notices must stay out of stdout: a numeric edge would extract from them.
    expect(r.stdout).not.toContain("limit reached");
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderrTruncated ?? false).toBe(false);
  });

  // The whole point of the exit-2 convention: `exit == 1` after a grep must mean
  // "we looked and there was nothing", never "we could not look". Anything else
  // sends a failed search down the no-matches branch claiming a fact it never
  // established.
  it("reports every could-not-search failure as 2, keeping 1 for no matches", async () => {
    expect((await grep({ pattern: "zzz-nothing-here" })).exitCode).toBe(1);
    expect((await grep({ pattern: "a(b" })).exitCode).toBe(2); // broken pattern
    expect((await grep({ pattern: "alpha", path: "nope" })).exitCode).toBe(2); // missing path
    expect((await grep({})).exitCode).toBe(2); // missing pattern
  });

  it("names the missing path and the base it resolved against", async () => {
    const r = await grep({ pattern: "alpha", path: "nope" });
    expect(r.stderr).toContain("grep: path not found: nope");
    expect(r.stderr).toContain(root);
  });

  it(`${mode}: announces the .gitignore divergence only when falling back`, async () => {
    // "accelerated" is a lie on a machine without ripgrep — the note must track
    // the path actually taken, not the mode label.
    const usesFallback = over === NODE_ONLY || !hasRg;
    const r = await grep({ pattern: "alpha" });
    expect(r.stderr.includes("does not honor .gitignore")).toBe(usesFallback);
  });
});

describe.each([
  ["accelerated", {} as Partial<ToolExecutorOptions>],
  ["node-only", NODE_ONLY],
])("mcp tool-ops — find (%s)", (mode, over) => {
  const find = (op: Omit<ToolOp, "tool">) => run({ tool: "find", ...op }, over);

  it("matches a bare glob against the basename at any depth", async () => {
    const r = await find({ pattern: "*.ts" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.split("\n")).toEqual(["sub/b.ts", "sub/nested/c.ts"]);
  });

  it("matches a glob containing a separator against the relative path", async () => {
    const r = await find({ pattern: "sub/*.ts" });
    expect(r.stdout).toBe("sub/b.ts");
  });

  it("supports ** across directories", async () => {
    const r = await find({ pattern: "**/*.txt" });
    expect(r.stdout.split("\n")).toEqual([".hidden.txt", "a.txt", "many.txt"]);
  });

  it("never returns node_modules entries", async () => {
    expect((await find({ pattern: "*.ts" })).stdout).not.toContain("node_modules");
  });

  it("no matches => empty stdout, exit 1", async () => {
    const r = await find({ pattern: "*.rs" });
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(1);
  });

  it("scopes to a directory path", async () => {
    const r = await find({ pattern: "*.ts", path: "sub/nested" });
    expect(r.stdout).toBe("sub/nested/c.ts");
  });

  it("caps at limit and announces the cap on stderr", async () => {
    const r = await find({ pattern: "*.ts", limit: 1 });
    expect(r.stdout).toBe("sub/b.ts");
    expect(r.stderr).toContain("1 result limit reached");
    expect(r.stdout).not.toContain("limit reached");
    expect(r.stdoutTruncated).toBe(true);
  });

  it("reports every could-not-search failure as 2, keeping 1 for no matches", async () => {
    expect((await find({ pattern: "*.rs" })).exitCode).toBe(1);
    expect((await find({ pattern: "*.ts", path: "nope" })).exitCode).toBe(2); // missing path
    expect((await find({ pattern: "*.ts", path: "a.txt" })).exitCode).toBe(2); // file target
    expect((await find({})).exitCode).toBe(2); // missing pattern
  });

  it("refuses a file target", async () => {
    const r = await find({ pattern: "*.ts", path: "a.txt" });
    expect(r.stderr).toContain("find searches a directory");
  });

  it(`${mode}: announces the .gitignore divergence only when falling back`, async () => {
    const usesFallback = over === NODE_ONLY || !hasFd;
    const r = await find({ pattern: "*.ts" });
    expect(r.stderr.includes("does not honor .gitignore")).toBe(usesFallback);
  });
});

// The pair above proves each mode in isolation; this proves they AGREE. If the
// fallback drifted, the same plan would branch differently on a machine without
// ripgrep — a false-hit sourced from the host's installed tooling.
describe("mcp tool-ops — accelerated/fallback parity", () => {
  it.skipIf(!hasRg)("grep returns identical stdout with and without ripgrep", async () => {
    for (const op of [
      { tool: "grep", pattern: "alpha" },
      { tool: "grep", pattern: "a", ignoreCase: true },
      { tool: "grep", pattern: "const", context: 1 },
      { tool: "grep", pattern: "alpha", glob: "*.ts" },
      { tool: "grep", pattern: "gamma", path: "sub" },
      // A single explicit file is where rg's output shape changes; the fallback
      // must still agree with it.
      { tool: "grep", pattern: "alpha", path: "a.txt" },
    ] as ToolOp[]) {
      const [fast, slow] = [await run(op), await run(op, NODE_ONLY)];
      expect(slow.stdout, JSON.stringify(op)).toBe(fast.stdout);
      expect(slow.exitCode, JSON.stringify(op)).toBe(fast.exitCode);
    }
  });

  it.skipIf(!hasFd)("find returns identical stdout with and without fd", async () => {
    for (const op of [
      { tool: "find", pattern: "*.ts" },
      { tool: "find", pattern: "**/*.txt" },
      { tool: "find", pattern: "c.ts" },
      { tool: "find", pattern: "*.ts", path: "sub" },
    ] as ToolOp[]) {
      const [fast, slow] = [await run(op), await run(op, NODE_ONLY)];
      expect(slow.stdout, JSON.stringify(op)).toBe(fast.stdout);
      expect(slow.exitCode, JSON.stringify(op)).toBe(fast.exitCode);
    }
  });
});

describe("mcp tool-ops — executor contract", () => {
  it("rejects an unknown tool the way the sibling adapters do", async () => {
    const r = await run({ tool: "deploy" });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("unknown tool: deploy");
  });

  it("reports missing required args instead of searching for an empty pattern", async () => {
    expect((await run({ tool: "read" })).stderr).toContain("missing required arg `path`");
    expect((await run({ tool: "grep" })).stderr).toContain("missing required arg `pattern`");
    expect((await run({ tool: "find" })).stderr).toContain("missing required arg `pattern`");
  });

  it("surfaces a dead accelerator binary as an error, not as an empty result", async () => {
    for (const [op, over] of [
      [{ tool: "grep", pattern: "alpha" }, { rgPath: join(root, "not-a-binary") }],
      [{ tool: "find", pattern: "*.ts" }, { fdPath: join(root, "not-a-binary") }],
    ] as [ToolOp, Partial<ToolExecutorOptions>][]) {
      const r = await run(op, over);
      // 2, not 1: a binary that never ran established nothing about matches.
      expect(r.exitCode, op.tool).toBe(2);
      expect(r.stdout, op.tool).toBe("");
      expect(r.stderr, op.tool).toContain(`${op.tool}:`);
    }
  });

  it.skipIf(!permissionDenialWorks)(
    "names a file it could not scan instead of silently skipping it, and marks the result incomplete (R26)",
    async () => {
      const dir = join(root, "partial-unreadable");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "readable.txt"), "hit\n");
      const blocked = join(dir, "blocked.txt");
      writeFileSync(blocked, "hit too\n");
      chmodSync(blocked, 0o000);
      try {
        const r = await run({ tool: "grep", pattern: "hit", path: "partial-unreadable" }, NODE_ONLY);
        // The readable file's match still comes through — one unscannable
        // file must not fail the whole op — but the skip is NAMED, never
        // silent (predexec's truncation-must-never-be-silent invariant), AND
        // the result is marked incomplete: an edge branching on exit==0 alone
        // would otherwise treat this identically to a fully-run search.
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toBe("partial-unreadable/readable.txt:1:hit");
        expect(r.stderr).toContain("blocked.txt");
        expect(r.stderr).toContain("skipping");
        expect(r.stdoutTruncated).toBe(true);
      } finally {
        chmodSync(blocked, 0o644);
      }
    },
  );

  it.skipIf(!permissionDenialWorks)(
    "returns exit 2, not 1, when the only candidate file could not be scanned at all",
    async () => {
      // exit 1 means "searched, found nothing" — a FACT. With the sole file
      // unreadable, that fact was never established: the search did not
      // fully run, which is exactly what exit 2 means elsewhere in this file
      // (a broken pattern, a dead accelerator, an abort). The rg path already
      // reports exit 2 for a permission error on its only target; the
      // fallback must not disagree by reporting a false "absent" via exit 1.
      const dir = join(root, "all-unreadable");
      mkdirSync(dir, { recursive: true });
      const blocked = join(dir, "blocked-only.txt");
      writeFileSync(blocked, "key\n");
      chmodSync(blocked, 0o000);
      try {
        const r = await run({ tool: "grep", pattern: "key", path: "all-unreadable" }, NODE_ONLY);
        expect(r.exitCode).toBe(2);
        expect(r.stdout).toBe("");
        expect(r.stderr).toContain("blocked-only.txt");
      } finally {
        chmodSync(blocked, 0o644);
      }
    },
  );

  it.skipIf(!hasRg)("agrees with ripgrep's exit 2 on a permission-denied sole target", async () => {
    const dir = join(root, "all-unreadable-parity");
    mkdirSync(dir, { recursive: true });
    const blocked = join(dir, "blocked-only.txt");
    writeFileSync(blocked, "key\n");
    chmodSync(blocked, 0o000);
    try {
      const withRg = await run({ tool: "grep", pattern: "key", path: "all-unreadable-parity" });
      expect(withRg.exitCode).toBe(2);
    } finally {
      chmodSync(blocked, 0o644);
    }
  });

  it("fails the whole op, not just one file, on a non-timeout regex execution error", async () => {
    // A vm-level throw that ISN'T the recognized timeout (e.g. a V8 regex
    // stack-overflow RangeError, per the ruling's own example) says something
    // is wrong with the pattern or the engine — not with any one file — so it
    // must not be swallowed into a per-file "skip" the way an I/O error is.
    // RegExp objects retain their prototype chain across the vm sandbox
    // boundary (verified: the sandbox never clones them), so patching
    // RegExp.prototype.test reliably reaches the exact call the batch
    // matcher makes, without needing to construct a genuinely pathological
    // native regex. The patch is restored BEFORE any assertion runs (not in a
    // `finally` after them): vitest's own failure-diffing machinery calls
    // `.test()` internally, so leaving the patch active while an assertion is
    // still being evaluated makes an unrelated failure look like an escaped
    // RangeError instead of a normal assertion mismatch (verified — this bit
    // during RED-phase testing here, when the pre-fix exit code legitimately
    // failed the assertion below while the patch was still in place).
    write("regex-error-dir/a.txt", "hit\n");
    write("regex-error-dir/b.txt", "hit\n");
    const originalTest = RegExp.prototype.test;
    RegExp.prototype.test = function () {
      throw new RangeError("Maximum call stack size exceeded");
    };
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run({ tool: "grep", pattern: "hit", path: "regex-error-dir" }, NODE_ONLY);
    } finally {
      RegExp.prototype.test = originalTest;
    }
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/RangeError|Maximum call stack/);
  });

  it("parses accelerator records whose filenames contain newlines", async () => {
    const filename = "line\nname.txt";
    write(filename, "hit\n");
    const fakeRg = join(root, "fake-rg-newline.cjs");
    writeFileSync(
      fakeRg,
      `#!/usr/bin/env node
const path = require("node:path");
const scope = process.argv.at(-1);
process.stdout.write(path.join(scope, ${JSON.stringify(filename)}) + "\\0" + "1:hit\\n");
`,
    );
    chmodSync(fakeRg, 0o755);
    const r = await run({ tool: "grep", pattern: "hit", path: "." }, { rgPath: fakeRg, fdPath: null });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`${filename}:1:hit`);
  });
});

describe("mcp tool-ops — accelerator process bounds", () => {
  it("kills and reports an accelerator that exceeds its hard timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(() => true),
      }) as ChildProcess;
      const execFile: ExecFileLike = (_file, _args, _options, _callback) => child;

      const pending = runBinary("fake-rg", [], undefined, execFile);
      const timedOut = expect(pending).rejects.toThrow("accelerator timed out after 10000ms");
      await vi.advanceTimersByTimeAsync(10_000);

      await timedOut;
      expect(child.kill).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the caller abort signal through without turning abort into no-results", async () => {
    const controller = new AbortController();
    controller.abort();
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }) as ChildProcess;
    let providedSignal: AbortSignal | undefined;
    const execFile: ExecFileLike = (_file, _args, options, callback) => {
      providedSignal = options.signal;
      callback(Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" }), "", "");
      return child;
    };

    await expect(runBinary("fake-rg", [], controller.signal, execFile)).rejects.toThrow("aborted");
    expect(providedSignal).toBe(controller.signal);
  });
});

describe("mcp tool-ops — helpers", () => {
  it("screens nested and ambiguous quantifiers before fallback regex construction", () => {
    for (const pattern of ["(a+)+$", "(a|a)+", "(a|aa)+", "(a|a?)+$"]) {
      expect(isSafeRegex(pattern), `${pattern} must be unsafe`).toBe(false);
    }
    expect(isSafeRegex("a+$"), "ordinary quantifier remains usable").toBe(true);
  });

  it("globToRegExp handles the documented subset", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false); // `*` stops at a separator
    expect(globToRegExp("**/*.ts").test("src/deep/a.ts")).toBe(true);
    expect(globToRegExp("**/*.ts").test("a.ts")).toBe(true); // `**/` spans zero dirs
    expect(globToRegExp("?.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("[ab].ts").test("b.ts")).toBe(true);
    expect(globToRegExp("[!ab].ts").test("b.ts")).toBe(false);
    expect(globToRegExp("a.ts").test("axts")).toBe(false); // `.` is a literal, not "any char"
  });

  it("globToRegExp degrades on unclosed syntax instead of throwing", () => {
    expect(() => globToRegExp("[abc")).not.toThrow();
    expect(globToRegExp("[abc").test("[abc")).toBe(true);
  });

  it("findOnPath finds a binary that exists and returns null for one that does not", () => {
    expect(findOnPath("px-definitely-not-a-real-binary")).toBeNull();
    // `node` is running this test, so it is on PATH by construction.
    expect(findOnPath(process.platform === "win32" ? "node.exe" : "node")).toContain("node");
  });
});

describe("mcp tool-ops — bounded fallback scans", () => {
  it("bounds directory-heavy fallback walks independently of file count", async () => {
    const dir = join(root, "directory-heavy-walk");
    mkdirSync(join(dir, "a", "leaf"), { recursive: true });
    mkdirSync(join(dir, "b", "leaf"), { recursive: true });
    mkdirSync(join(dir, "c", "leaf"), { recursive: true });

    const walked = await walkFiles(realpathSync(dir), undefined, {
      maxFiles: 100,
      maxDirectories: 2,
      maxEntries: 100,
      maxWork: 100,
    });

    expect(walked.capped).toBe(true);
    expect(walked.files).toEqual([]);
  });

  it("searches empty files and the synthetic terminal line from LF splitting", async () => {
    write("empty-grep.txt", "");
    write("trailing-empty-grep.txt", "one\n");
    const empty = await run({ tool: "grep", pattern: "^$", path: "empty-grep.txt" }, NODE_ONLY);
    const trailing = await run({ tool: "grep", pattern: "^$", path: "trailing-empty-grep.txt" }, NODE_ONLY);
    expect(empty).toMatchObject({ exitCode: 0, stdout: "empty-grep.txt:1:" });
    expect(trailing).toMatchObject({ exitCode: 0, stdout: "trailing-empty-grep.txt:2:" });
  });

  it("preserves carriage returns because only LF terminates fallback lines", async () => {
    write("legacy-lines.txt", Buffer.from("one\r\ntwo\rthree\n", "utf8"));
    const read = await run({ tool: "read", path: "legacy-lines.txt" }, NODE_ONLY);
    const grep = await run({ tool: "grep", pattern: "^two\\rthree$", path: "legacy-lines.txt" }, NODE_ONLY);
    expect(read.stdout).toBe("one\r\ntwo\rthree\n");
    expect(grep).toMatchObject({ exitCode: 0, stdout: "legacy-lines.txt:2:two\rthree" });
  });

  it("discards ALL matches when the file is binary, regardless of the retention cap", async () => {
    // Binary-ness is a whole-file fact scanTextLines always determines (the
    // raw NUL check runs on every chunk independent of callback state), so it
    // must never depend on `limit` or on how many matches were already
    // collected — rg itself skips a binary file's matches unconditionally,
    // and the fallback must agree, or an `exit == 0` edge fires on raw binary
    // content depending only on which `limit` the plan happened to pick.
    write("binary-after-cap.dat", Buffer.concat([Buffer.from("hit\nhit\nhit\nhit\n", "utf8"), Buffer.from([0, 1, 2, 3])]));
    const r = await run({ tool: "grep", pattern: "hit", path: "binary-after-cap.dat", limit: 3 }, NODE_ONLY);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toContain("match limit reached");
  });

  it("keeps matches already found before the retention cap when a LATER line is merely oversized (not binary)", async () => {
    // Distinct from binary: oversized fires only once scanTextLines actually
    // hits a line too long to safely buffer, and — unlike a NUL byte, which
    // taints the whole file — a later oversized line doesn't retroactively
    // invalidate matches already collected from earlier, cleanly-decoded
    // lines. No NUL byte anywhere in this fixture, so `scan.binary` stays
    // false throughout; only `scan.oversized` fires.
    write("oversized-after-cap.dat", `hit\nhit\nhit\nhit\n${"a".repeat(128 * 1024)}\n`);
    const r = await run({ tool: "grep", pattern: "hit", path: "oversized-after-cap.dat", limit: 3 }, NODE_ONLY);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      ["oversized-after-cap.dat:1:hit", "oversized-after-cap.dat:2:hit", "oversized-after-cap.dat:3:hit"].join("\n"),
    );
    expect(r.stderr).toContain("match limit reached");
  });

  it("discards binary matches the same way regardless of `limit` (limit:2 vs limit:3 parity)", async () => {
    // Lines that themselves carry embedded NUL bytes mixed with matching
    // text — the file is binary throughout, not just in trailing garbage —
    // reproducing the exact regression: exit 0 with raw binary content at a
    // small `limit`, exit 1 at a larger one, for the SAME file.
    const lines = Array.from({ length: 5 }, (_, i) => `key${i}\0extra`);
    write("embedded-nul.bin", `${lines.join("\n")}\n`);
    for (const limit of [2, 3, 100]) {
      const r = await run({ tool: "grep", pattern: "key", path: "embedded-nul.bin", limit }, NODE_ONLY);
      expect(r.exitCode, `limit=${limit}`).toBe(1);
      expect(r.stdout, `limit=${limit}`).toBe("");
    }
  });

  it.skipIf(!hasRg)("agrees with ripgrep that a binary file's matches are excluded, at every limit", async () => {
    write("embedded-nul-parity.bin", "key1\0extra\nkey2\0extra\n");
    for (const limit of [1, 2, 100]) {
      const withRg = await run({ tool: "grep", pattern: "key", path: "embedded-nul-parity.bin", limit });
      const withoutRg = await run({ tool: "grep", pattern: "key", path: "embedded-nul-parity.bin", limit }, NODE_ONLY);
      expect(withRg.exitCode, `rg limit=${limit}`).toBe(1);
      expect(withoutRg.exitCode, `node limit=${limit}`).toBe(1);
    }
  });

  it("classifies aborted fallback read and grep as never-ran", async () => {
    write("abort.txt", "ready\n");
    const executor = createToolExecutor({ cwd: root, ...NODE_ONLY });
    const controller = new AbortController();
    controller.abort();
    const read = await executor({ tool: "read", path: "abort.txt" }, { cwd: root, signal: controller.signal });
    const grep = await executor({ tool: "grep", pattern: "ready", path: "abort.txt" }, { cwd: root, signal: controller.signal });
    expect(read.exitCode).toBe(2);
    expect(read.stderr).toContain("aborted");
    expect(grep.exitCode).toBe(2);
    expect(grep.stderr).toContain("aborted");
  });

  it.each(["(a+)+$", "(a|a)+", "(a|aa)+", "(a|a?)+$"])(
    "rejects unsafe regex %s with search-not-run exit 2",
    async (pattern) => {
      const path = `unsafe-${pattern.replace(/[^a-z0-9]/gi, "-")}.txt`;
      write(path, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
      const r = await run({ tool: "grep", pattern, path }, NODE_ONLY);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("unsafe pattern");
    },
  );

  it.skipIf(!hasRg)("rejects an unsafe pattern identically whether or not ripgrep is installed", async () => {
    // rg's Rust engine is linear-time and would happily run an "unsafe" pattern
    // rg itself never hangs on — but the model author sees the same tool op on
    // every machine, so both paths must reject it the same way (R8).
    const pattern = "(a+)+$";
    write("unsafe-parity.txt", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    const withRg = await run({ tool: "grep", pattern, path: "unsafe-parity.txt" });
    const withoutRg = await run({ tool: "grep", pattern, path: "unsafe-parity.txt" }, NODE_ONLY);
    expect(withRg.exitCode).toBe(2);
    expect(withRg.stderr).toContain("unsafe pattern");
    expect(withoutRg).toEqual(withRg);
  });

  it("bounds a single catastrophic regex evaluation that isSafeRegex's screen does not catch", async () => {
    // isSafeRegex only screens grouped/alternated repetition; an ungrouped run
    // of quantified atoms like a*a*a*a* is a known polynomial-time ReDoS shape
    // that still passes it (documented in core/conditions.ts). Without a
    // deadline this single .test() call blocks the walk indefinitely
    // (measured on this pattern/length: ~3.5s uninterrupted) — the op-level
    // budget interrupts it at GREP_OP_TIMEOUT_MS, its own first (and only)
    // batch call getting the full budget as its vm timeout.
    const pattern = "a*a*a*a*b";
    expect(isSafeRegex(pattern)).toBe(true);
    write("slow-regex.txt", `${"a".repeat(180)}\n`);
    const start = Date.now();
    const r = await run({ tool: "grep", pattern, path: "slow-regex.txt" }, NODE_ONLY);
    expect(Date.now() - start).toBeLessThan(GREP_OP_TIMEOUT_MS + 500);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("time budget");
  });

  it("aborts on a shared cumulative budget across MANY batches that are each individually fast", async () => {
    // Each 1000-line batch here costs roughly 150-200ms on its own — nowhere
    // near a single batch's own timeout — but the op-level budget is shared
    // across every batch in the op, not reset per batch: a fixed number of
    // such batches must still cross GREP_OP_TIMEOUT_MS and abort, which a
    // per-batch-reset deadline (round 1's design) would never do (measured:
    // 6.7s with no timeout at 5000-line/101-char-line scale under that
    // design). 60k lines gives ~60 batches, comfortably enough to cross the
    // budget partway through regardless of machine speed.
    const pattern = "a*a*a*a*b";
    expect(isSafeRegex(pattern)).toBe(true);
    write("many-batches-regex.txt", `${Array.from({ length: 60_000 }, () => "a".repeat(22)).join("\n")}\n`);
    const start = Date.now();
    const r = await run({ tool: "grep", pattern, path: "many-batches-regex.txt" }, NODE_ONLY);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThan(GREP_OP_TIMEOUT_MS - 200);
    expect(elapsed).toBeLessThan(GREP_OP_TIMEOUT_MS + 1000);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("time budget");
  });

  it("aborts within the op budget across many FILES, not just many batches in one file", async () => {
    // Reproduces the reviewer's own probe: 20 files of 101 lines each, no
    // single file's one-batch cost anywhere near GREP_OP_TIMEOUT_MS alone,
    // but the budget is shared across files too (a fresh per-file budget,
    // round-1's design, measured 3.9s across 20 such files with no timeout).
    for (let i = 0; i < 20; i++) {
      write(`many-files/f${i}.txt`, `${Array.from({ length: 101 }, () => "a".repeat(38)).join("\n")}\n`);
    }
    const pattern = "a*a*a*a*b";
    expect(isSafeRegex(pattern)).toBe(true);
    const start = Date.now();
    const r = await run({ tool: "grep", pattern, path: "many-files" }, NODE_ONLY);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(GREP_OP_TIMEOUT_MS + 1000);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("time budget");
  });

  it("keeps limit:1 on a large no-match file fast (batch size must not depend on limit)", async () => {
    // Round 1 tied batch size to `limit - found + 1`, which collapsed to a
    // 2-line batch for the whole scan at limit:1 (measured: ~2s for 100k
    // lines, ~35x the default-limit run). Batch size must stay fixed and
    // large regardless of `limit`; the exact stop-at-limit point is a
    // host-side computation over a batch's full match list, not the batch
    // size itself.
    write("limit-one.txt", `${Array.from({ length: 100_000 }, (_, i) => `line ${i}`).join("\n")}\n`);
    const start = Date.now();
    const r = await run({ tool: "grep", pattern: "line 100001", path: "limit-one.txt", limit: 1 }, NODE_ONLY);
    expect(Date.now() - start).toBeLessThan(500);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
  });

  it("keeps an ordinary large-file fallback grep fast (regression guard for vm-entry overhead)", async () => {
    // Measured on the naive per-line-vm design: a 100k-line fallback grep took
    // ~4.5s (vs ~5ms for a bare, unwrapped RegExp#test loop) — an ~800x tax
    // from entering node:vm once per line. Batching many lines into each vm
    // invocation must keep an ordinary, non-adversarial large-file grep fast.
    write("large-fallback.txt", `${Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join("\n")}\n`);
    const start = Date.now();
    const r = await run({ tool: "grep", pattern: "line 49999", path: "large-fallback.txt" }, NODE_ONLY);
    expect(Date.now() - start).toBeLessThan(1500);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("large-fallback.txt:50000:line 49999");
  });

  it("refuses an unterminated line over the fallback scan bound", async () => {
    write("oversized-line.txt", `${"x".repeat(64 * 1024 + 1)}\n`);
    const read = await run({ tool: "read", path: "oversized-line.txt" }, NODE_ONLY);
    expect(read.exitCode).toBe(2);
    expect(read.stdout).toBe("");
    expect(read.stderr).toContain("line exceeds");

    const grep = await run({ tool: "grep", pattern: "x", path: "oversized-line.txt" }, NODE_ONLY);
    expect(grep.exitCode).toBe(2);
    expect(grep.stdout).toBe("");
    expect(grep.stderr).toContain("line exceeds");
  });

  it("returns lexically ordered matches and stops at the first over-limit match", async () => {
    write("bounded/z-last.txt", "hit\n");
    write("bounded/a-first.txt", "hit\n");
    write("bounded/m-middle.txt", "hit\n");
    write("bounded/n-fourth.txt", "hit\n");
    write("bounded/z-after-limit.txt", "hit\n");

    const r = await run({ tool: "grep", pattern: "hit", path: "bounded", limit: 3 }, NODE_ONLY);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe([
      "bounded/a-first.txt:1:hit",
      "bounded/m-middle.txt:1:hit",
      "bounded/n-fourth.txt:1:hit",
    ].join("\n"));
    expect(r.stderr).toContain("3 match limit reached");
  });

  it("preserves offset and continuation output for large streamed text reads", async () => {
    const lines = Array.from({ length: 12000 }, (_, i) => `line-${i + 1}`);
    write("large-stream.txt", `${lines.join("\n")}\n`);
    const r = await run({ tool: "read", path: "large-stream.txt", offset: 2, limit: 2 });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("line-2\nline-3");
    expect(r.stderr).toBe("read: showing lines 2-3 of 12001 in large-stream.txt — use offset=4 to continue");
  });
});
