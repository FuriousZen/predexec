import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolOp } from "../../core/index.ts";
import {
  createToolExecutor,
  findOnPath,
  globToRegExp,
  type ToolExecutorOptions,
} from "../../mcp/tool-ops.ts";

// A real tree on disk: these ops are node:fs all the way down, so mocking the
// filesystem would only test the mock. The temp dir is deliberately NOT a git
// repo — rg/fd apply .gitignore only inside one, which keeps the accelerated
// and fallback file sets comparable in the parity tests below.
const root = mkdtempSync(join(tmpdir(), "px-toolops-"));
const outside = mkdtempSync(join(tmpdir(), "px-outside-"));

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

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Forces the pure-Node path regardless of what is installed on this machine. */
const NODE_ONLY: Partial<ToolExecutorOptions> = { rgPath: null, fdPath: null };

const run = (op: ToolOp, over: Partial<ToolExecutorOptions> = {}, cwd = root) =>
  createToolExecutor({ cwd: root, ...over })(op, { cwd });

const hasRg = findOnPath("rg") !== null;
const hasFd = findOnPath("fd") !== null;

describe("mcp tool-ops — read", () => {
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
  });

  it("reads to EOF silently when limit covers the file", async () => {
    const r = await run({ tool: "read", path: "a.txt", offset: 3, limit: 50 });
    expect(r.stdout).toBe("gamma\n");
    expect(r.stderr).toBe("");
  });

  it("rejects an offset past EOF instead of returning empty stdout", async () => {
    const r = await run({ tool: "read", path: "a.txt", offset: 99 });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("offset 99 is past the end of a.txt (4 lines)");
    expect(r.stdout).toBe("");
  });

  it("reports a missing path with the base it resolved against", async () => {
    const r = await run({ tool: "read", path: "nope.txt" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("read: path not found: nope.txt");
    expect(r.stderr).toContain(root);
  });

  it("refuses a directory and points at ls", async () => {
    const r = await run({ tool: "read", path: "sub" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('is a directory — use {tool:"ls"}');
  });

  it("refuses a binary file rather than dumping bytes into the transcript", async () => {
    const r = await run({ tool: "read", path: "bin.dat" });
    expect(r.exitCode).toBe(1);
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
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("outside the predexec root");
    expect(r.stdout).toBe("");
  });

  it("rejects an absolute path outside the root", async () => {
    const r = await run({ tool: "read", path: join(outside, "secret.txt") });
    expect(r.exitCode).toBe(1);
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
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("outside the predexec root");
  });

  it("rejects an escaping op cwd by name, not as a missing path", async () => {
    // The engine folds plan.cwd into RunOptions.cwd, so a plan pointing its cwd
    // out of the session arrives here as an escaping base.
    const r = await run({ tool: "ls" }, {}, outside);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("a plan's cwd may not escape the session root");
  });

  it("rejects escaping paths for every op, not just read", async () => {
    // grep/find report 2, not 1: an escaping path never searched anything, and
    // exit 1 is reserved for "searched, found nothing".
    for (const [op, exit] of [
      [{ tool: "ls", path: ".." }, 1],
      [{ tool: "grep", pattern: "alpha", path: ".." }, 2],
      [{ tool: "find", pattern: "*.ts", path: ".." }, 2],
    ] as [ToolOp, number][]) {
      const r = await run(op);
      expect(r.exitCode, op.tool).toBe(exit);
      expect(r.stderr, op.tool).toContain("outside the predexec root");
    }
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
  });

  it("reports a missing directory", async () => {
    const r = await run({ tool: "ls", path: "nope" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("ls: path not found: nope");
  });

  it("refuses a file and points at read", async () => {
    const r = await run({ tool: "ls", path: "a.txt" });
    expect(r.exitCode).toBe(1);
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
    expect(r.exitCode).toBe(1);
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
});

describe("mcp tool-ops — helpers", () => {
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
