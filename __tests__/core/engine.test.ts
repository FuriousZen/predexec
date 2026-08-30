import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePlanCwd, runPlanTree, validatePlan } from "../../core/engine.ts";
import type { PlanNode, PlanTree, ToolOp, RunOptions } from "../../core/types.ts";

const cwd = process.cwd();

const mockToolExecutor = async (op: ToolOp) => {
  if (op.tool === "read") return { stdout: `file: ${op.path}\nstrict: true`, stderr: "", exitCode: 0 };
  if (op.tool === "grep") return { stdout: `${op.path}:5:${op.pattern}`, stderr: "", exitCode: 0 };
  if (op.tool === "find") return { stdout: "src/a.ts\nsrc/b.ts", stderr: "", exitCode: 0 };
  if (op.tool === "ls") return { stdout: "file1\nfile2\ndir1/", stderr: "", exitCode: 0 };
  return { stdout: "", stderr: `unknown: ${op.tool}`, exitCode: 1 };
};

describe("runPlanTree — traversal & stop reasons", () => {
  it("depth-0 leaf: runs one command, no fallback, terminal on success", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo hi"] }] };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("leaf");
    expect(r.fellBack).toBe(false);
    expect(r.terminal).toBe(true);
    expect(r.pathTaken).toEqual(["a"]);
    expect(r.depthReached).toBe(0);
  });

  it("a failing leaf is not terminal", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["exit 1"] }] };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("leaf");
    expect(r.terminal).toBe(false);
  });

  it("follows the first matching edge to a child", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [
        { id: "a", commands: ["exit 0"], edges: [{ when: { kind: "exitCode", op: "eq", value: 0 }, to: "ok" }] },
        { id: "ok", commands: ["echo matched"] },
      ],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.pathTaken).toEqual(["a", "ok"]);
    expect(r.depthReached).toBe(1);
    expect(r.edgesMatched).toBe(1);
    expect(r.transcript).toContain("matched");
  });

  it("first-match edge ordering: earlier edge wins even when both match", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [
        {
          id: "a",
          commands: ["exit 0"],
          edges: [
            { when: { kind: "always" }, to: "first" },
            { when: { kind: "exitCode", op: "eq", value: 0 }, to: "second" },
          ],
        },
        { id: "first", commands: ["echo first"] },
        { id: "second", commands: ["echo second"] },
      ],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.pathTaken).toEqual(["a", "first"]);
    expect(r.edgesEvaluated).toBe(1); // stops at the first match
  });

  it("noEdgeMatch: stops and falls back when no edge matches", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [
        { id: "a", commands: ["exit 0"], edges: [{ when: { kind: "exitCode", op: "eq", value: 99 }, to: "b" }] },
        { id: "b", commands: ["echo b"] },
      ],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("noEdgeMatch");
    expect(r.fellBack).toBe(true);
    expect(r.pathTaken).toEqual(["a"]);
    expect(r.edgesEvaluated).toBe(1);
    expect(r.edgesMatched).toBe(0);
  });

  it("maxDepth: stops at the cap", async () => {
    const plan: PlanTree = {
      root: "a",
      maxDepth: 0,
      nodes: [
        { id: "a", commands: ["exit 0"], edges: [{ when: { kind: "always" }, to: "b" }] },
        { id: "b", commands: ["echo b"] },
      ],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("maxDepth");
    expect(r.fellBack).toBe(true);
    expect(r.pathTaken).toEqual(["a"]);
  });

  it("mutationStop: hard-stops BEFORE running a declared mutating node", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [
        { id: "a", commands: ["exit 0"], edges: [{ when: { kind: "always" }, to: "w" }] },
        { id: "w", commands: ["echo SHOULD_NOT_RUN"], mutates: true },
      ],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("mutationStop");
    expect(r.fellBack).toBe(true);
    expect(r.pathTaken).toEqual(["a"]); // child never ran
    expect(r.transcript).not.toContain("node w (exit"); // no execution block for w
    expect(r.transcript).toContain("HARD-STOP");
  });

  it("mutationStop: undeclared destructive command is caught by the heuristic", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["rm -rf /tmp/whatever"] }] };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("mutationStop");
    expect(r.pathTaken).toEqual([]); // never ran
  });

  it("mutationStop: ordinary cp stops before runNode creates the destination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "predexec-cp-"));
    try {
      writeFileSync(join(dir, "source.txt"), "source\n");
      const r = await runPlanTree(
        { root: "a", nodes: [{ id: "a", commands: ["cp source.txt destination.txt"] }] },
        { cwd: dir },
      );
      expect(r.stoppedReason).toBe("mutationStop");
      expect(r.pathTaken).toEqual([]);
      expect(existsSync(join(dir, "destination.txt"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    `perl -e "rename('a','b')"`,
    `ruby -e "File.write('out', 'x')"`,
    `php -r "file_put_contents('out', 'x');"`,
    `php -r "fopen('out', 'w');"`,
  ])("mutationStop: interpreter writer %s never executes", async (command) => {
    const dir = mkdtempSync(join(tmpdir(), "predexec-interpreter-"));
    try {
      const r = await runPlanTree(
        { root: "a", nodes: [{ id: "a", commands: [command] }] },
        { cwd: dir },
      );
      expect(r.stoppedReason).toBe("mutationStop");
      expect(r.pathTaken).toEqual([]);
      expect(existsSync(join(dir, "out"))).toBe(false);
      expect(existsSync(join(dir, "b"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(
    !["/usr/bin/ruby", "/usr/local/bin/ruby", "/opt/homebrew/bin/ruby"].some(existsSync) ||
      !["/usr/bin/perl", "/usr/local/bin/perl", "/opt/homebrew/bin/perl"].some(existsSync),
  )("mutationStop: valid whole-token quoted Ruby/Perl eval writers never execute", async () => {
    const dir = mkdtempSync(join(tmpdir(), "predexec-attached-eval-"));
    try {
      const commands = [
        `ruby '-eFile.write("created", "x")'`,
        `env ruby '-eFile.write("created", "x")'`,
        `printf ok | env ruby '-eFile.write("created", "x")'`,
        `perl '-eunlink("victim")'`,
        `command perl '-eunlink("victim")'`,
        `printf ok | env perl '-eunlink("victim")'`,
      ];
      writeFileSync(join(dir, "victim"), "keep\n");
      for (const command of commands) {
        const result = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [command] }] }, { cwd: dir });
        expect(result.stoppedReason).toBe("mutationStop");
        expect(result.pathTaken).toEqual([]);
      }
      expect(existsSync(join(dir, "created"))).toBe(false);
      expect(readFileSync(join(dir, "victim"), "utf8")).toBe("keep\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync("/usr/bin/ruby") && !existsSync("/opt/homebrew/bin/ruby"))(
    "mutationStop: installed Ruby writers cannot create, delete, or modify temp files",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "predexec-ruby-probe-"));
      try {
        const victim = join(dir, "victim");
        writeFileSync(victim, "keep\n");
        const commands = [
          "ruby -e \"FileUtils::mkdir_p('created')\"",
          "ruby -e \"File::delete('victim')\"",
          "ruby -e \"File.open('victim', 'rb+') { |f| f.write('changed') }\"",
          String.raw`ruby -e 'File.open("victim", "\x77") { |f| f.write("changed") }'`,
          "ruby -e \"require 'fileutils'; FileUtils::remove_entry('victim')\"",
          "ruby -e \"require 'fileutils'; FileUtils.ln_sf('victim', 'linked')\"",
        ];
        for (const command of commands) {
          const result = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [command] }] }, { cwd: dir });
          expect(result.stoppedReason).toBe("mutationStop");
          expect(result.pathTaken).toEqual([]);
        }
        expect(existsSync(join(dir, "created"))).toBe(false);
        expect(existsSync(victim)).toBe(true);
        expect(existsSync(join(dir, "linked"))).toBe(false);
        expect(readFileSync(victim, "utf8")).toBe("keep\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(
    (![process.execPath, "/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node"].some(existsSync)) ||
      (!["/usr/bin/ruby", "/usr/local/bin/ruby", "/opt/homebrew/bin/ruby"].some(existsSync)) ||
      (!["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"].some(existsSync)),
  )("allows installed interpreters to run escaped/literal interpolation data without writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "predexec-interpolation-read-"));
    try {
      const commands = [
        "node -e 'const fs=require(\"fs\"); const x = `safe \\${fs.writeFileSync(\"created\", \"x\")}`; console.log(x)'",
        `ruby -e 'puts %q{#{File.write("created", "x")}}'`,
        `python3 -c "from pathlib import Path; print(f'{{Path(\"created\").write_text(\"x\")}}')"`,
      ];
      for (const command of commands) {
        const result = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [command] }] }, { cwd: dir });
        expect(result.stoppedReason).toBe("leaf");
        expect(result.pathTaken).toEqual(["a"]);
      }
      expect(existsSync(join(dir, "created"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(![process.execPath, "/usr/bin/node", "/usr/local/bin/node", "/opt/homebrew/bin/node"].some(existsSync))(
    "mutationStop: Node template interpolation writers never execute",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "predexec-node-interpolation-"));
      try {
        const command = `node -e 'const fs=require("fs"); const x = \`safe \${fs.writeFileSync("created", "x")}\`'`;
        const result = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [command] }] }, { cwd: dir });
        expect(result.stoppedReason).toBe("mutationStop");
        expect(result.pathTaken).toEqual([]);
        expect(existsSync(join(dir, "created"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!["/usr/bin/python3", "/usr/local/bin/python3", "/opt/homebrew/bin/python3"].some(existsSync))(
    "mutationStop: Python f-string interpolation writers never execute",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "predexec-python-interpolation-"));
      try {
        const command = `python3 -c "from pathlib import Path; x=f'''safe {Path('created').write_text('x')}'''"`;
        const result = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [command] }] }, { cwd: dir });
        expect(result.stoppedReason).toBe("mutationStop");
        expect(result.pathTaken).toEqual([]);
        expect(existsSync(join(dir, "created"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!["/usr/bin/ruby", "/usr/local/bin/ruby", "/opt/homebrew/bin/ruby"].some(existsSync))(
    "mutationStop: Ruby interpolated strings writers never execute",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "predexec-ruby-interpolation-"));
      try {
        const command = `ruby -e 'x = %Q{safe #{File.write("created", "x")}}'`;
        const result = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [command] }] }, { cwd: dir });
        expect(result.stoppedReason).toBe("mutationStop");
        expect(result.pathTaken).toEqual([]);
        expect(existsSync(join(dir, "created"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!existsSync("/usr/bin/perl") && !existsSync("/opt/homebrew/bin/perl"))(
    "allows an installed Perl O_RDONLY sysopen despite printed/commented writer flags",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "predexec-perl-read-probe-"));
      try {
        const victim = join(dir, "victim");
        writeFileSync(victim, "keep\n");
        const command = `perl -e "use Fcntl qw(O_RDONLY); sysopen(FH, 'victim', O_RDONLY); print 'O_TRUNC'; # O_WRONLY"`;
        const result = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [command] }] }, { cwd: dir });
        expect(result.stoppedReason).toBe("leaf");
        expect(result.pathTaken).toEqual(["a"]);
        expect(readFileSync(victim, "utf8")).toBe("keep\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!existsSync("/usr/bin/perl") && !existsSync("/opt/homebrew/bin/perl"))(
    "allows a real Perl bare sysopen reader with an unfinished commented argument",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "predexec-perl-bare-read-probe-"));
      try {
        const victim = join(dir, "victim");
        writeFileSync(victim, "keep\n");
        const command = `perl -e "use Fcntl qw(O_RDONLY); sysopen FH, 'victim', # O_TRUNC\n O_RDONLY; print <FH>"`;
        const result = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [command] }] }, { cwd: dir });
        expect(result.stoppedReason).toBe("leaf");
        expect(result.pathTaken).toEqual(["a"]);
        expect(readFileSync(victim, "utf8")).toBe("keep\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!existsSync("/usr/bin/ruby") && !existsSync("/opt/homebrew/bin/ruby"))(
    "allows a real Ruby File.open reader when a comment precedes the mode",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "predexec-ruby-read-probe-"));
      try {
        const victim = join(dir, "victim");
        writeFileSync(victim, "keep\n");
        const command = `ruby -e "File.open('victim', # 'w' hidden\n 'rb') { |f| puts f.read }"`;
        const result = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [command] }] }, { cwd: dir });
        expect(result.stoppedReason).toBe("leaf");
        expect(result.pathTaken).toEqual(["a"]);
        expect(readFileSync(victim, "utf8")).toBe("keep\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!existsSync("/usr/bin/php") && !existsSync("/opt/homebrew/bin/php"))(
    "allows a real PHP fopen reader when a comment precedes the mode",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "predexec-php-read-probe-"));
      try {
        const victim = join(dir, "victim");
        writeFileSync(victim, "keep\n");
        const command = `php -r "fopen('victim', // 'w' hidden\n 'r');"`;
        const result = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [command] }] }, { cwd: dir });
        expect(result.stoppedReason).toBe("leaf");
        expect(result.pathTaken).toEqual(["a"]);
        expect(readFileSync(victim, "utf8")).toBe("keep\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!existsSync("/usr/bin/perl") && !existsSync("/opt/homebrew/bin/perl"))(
    "mutationStop: installed Perl writers cannot create, delete, or modify temp files",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "predexec-perl-probe-"));
      try {
        const victim = join(dir, "victim");
        writeFileSync(victim, "keep\n");
        const commands = [
          `perl -e "open(FH, '>:encoding(UTF-8)', 'created')"`,
          String.raw`perl -e 'open(FH, "\x3e", "created")'`,
          `perl -e "unlink('victim')"`,
          `perl -e "sysopen(FH, 'victim', O_WRONLY)"`,
          "perl -e 'print qq{safe ${\\unlink(\"victim\")}}'",
        ];
        for (const command of commands) {
          const result = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [command] }] }, { cwd: dir });
          expect(result.stoppedReason).toBe("mutationStop");
          expect(result.pathTaken).toEqual([]);
        }
        expect(existsSync(join(dir, "created"))).toBe(false);
        expect(existsSync(victim)).toBe(true);
        expect(readFileSync(victim, "utf8")).toBe("keep\n");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(
    !["/usr/bin/perl", "/usr/local/bin/perl", "/opt/homebrew/bin/perl", "/usr/bin/ruby", "/usr/local/bin/ruby", "/opt/homebrew/bin/ruby", "/usr/bin/php", "/usr/local/bin/php", "/opt/homebrew/bin/php"].some(existsSync),
  )("mutationStop: shell-executing qx/backtick bodies never create or delete files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "predexec-shell-body-"));
    try {
      writeFileSync(join(dir, "victim"), "keep\n");
      const commands = [
        `perl -e 'qx{rm -f victim}'`,
        `perl -e 'qx{printf hi > created}'`,
        `ruby -e 'x = \`rm -f victim\`'`,
        `ruby -e 'x = \`printf hi > created\`'`,
        `ruby -e 'x = \`echo #{File.write("created", "x")}\`'`,
        "perl -e 'x = qx{echo ${\\\\unlink(\"victim\")}}'",
        `php -r '$x = \`rm -f victim\`;'`,
        `php -r '$x = \`printf hi > created\`;'`,
      ];
      for (const command of commands) {
        const result = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [command] }] }, { cwd: dir });
        expect(result.stoppedReason).toBe("mutationStop");
        expect(result.pathTaken).toEqual([]);
      }
      expect(existsSync(join(dir, "created"))).toBe(false);
      expect(existsSync(join(dir, "victim"))).toBe(true);
      expect(readFileSync(join(dir, "victim"), "utf8")).toBe("keep\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(
    !["/usr/bin/perl", "/usr/local/bin/perl", "/opt/homebrew/bin/perl", "/usr/bin/ruby", "/usr/local/bin/ruby", "/opt/homebrew/bin/ruby", "/usr/bin/php", "/usr/local/bin/php", "/opt/homebrew/bin/php"].some(existsSync),
  )("allows installed read-only qx/backtick bodies to reach a leaf", async () => {
    const dir = mkdtempSync(join(tmpdir(), "predexec-shell-body-read-"));
    try {
      const commands = [
        `perl -e 'qx{printf hi}'`,
        `ruby -e 'x = \`printf hi\`'`,
        `php -r '$x = \`printf hi\`;'`,
      ];
      for (const command of commands) {
        const result = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [command] }] }, { cwd: dir });
        expect(result.stoppedReason).toBe("leaf");
        expect(result.pathTaken).toEqual(["a"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    "/usr/bin/time -o timing.log printf hi",
    "time --output timing.log printf hi",
    "time -ofile printf hi",
    "time --output=file printf hi",
    "env -u X /usr/bin/time -o timing.log printf hi",
    "nice -n 5 /usr/bin/time -o timing.log printf hi",
    "env time -o timing.log printf hi",
    "time -ao timing.log printf hi",
    "( /usr/bin/time -o timing.log printf hi )",
  ])("mutationStop: %s stops before runNode creates the timing file", async (command) => {
    const dir = mkdtempSync(join(tmpdir(), "predexec-time-"));
    try {
      const r = await runPlanTree(
        { root: "a", nodes: [{ id: "a", commands: [command] }] },
        { cwd: dir },
      );
      expect(r.stoppedReason).toBe("mutationStop");
      expect(r.pathTaken).toEqual([]);
      expect(existsSync(join(dir, "timing.log"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mutationStop: newline-separated Git mutation stops before runNode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "predexec-git-"));
    try {
      const r = await runPlanTree(
        { root: "a", nodes: [{ id: "a", commands: ["git status\ngit init scratch"] }] },
        { cwd: dir },
      );
      expect(r.stoppedReason).toBe("mutationStop");
      expect(r.pathTaken).toEqual([]);
      expect(existsSync(join(dir, "scratch", ".git"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    "env -iu GIT_CONFIG_NOSYSTEM git init scratch",
    "env -iS\"git init scratch\"",
    "{ git init scratch; }",
    "if git init scratch; then :; fi",
    'echo "$(git init scratch)"',
  ])("mutationStop: hidden Git mutation %s stops before execution", async (command) => {
    const dir = mkdtempSync(join(tmpdir(), "predexec-hidden-git-"));
    try {
      const r = await runPlanTree(
        { root: "a", nodes: [{ id: "a", commands: [command] }] },
        { cwd: dir },
      );
      expect(r.stoppedReason).toBe("mutationStop");
      expect(r.pathTaken).toEqual([]);
      expect(existsSync(join(dir, "scratch", ".git"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    `echo "$(printf '('; git init scratch)"`,
    "case x in a) echo ok ;; b) git init scratch ;; esac",
    "coproc git init scratch",
  ])("mutationStop: executable shell syntax %s is never run", async (command) => {
    const dir = mkdtempSync(join(tmpdir(), "predexec-shell-boundary-"));
    try {
      const r = await runPlanTree(
        { root: "a", nodes: [{ id: "a", commands: [command] }] },
        { cwd: dir },
      );
      expect(r.stoppedReason).toBe("mutationStop");
      expect(r.pathTaken).toEqual([]);
      expect(existsSync(join(dir, "scratch", ".git"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT false-positive on 2>/dev/null or 2>&1", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: ["ls foo 2>/dev/null || echo missing", "cat bar 2>&1"] }],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).not.toBe("mutationStop");
    expect(r.pathTaken).toContain("a");
  });

  it("does NOT false-positive on a spaced `> /dev/null` redirect (benign discard)", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: ["grep foo bar > /dev/null || echo none", "ls -la >/dev/null 2>&1"] }],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).not.toBe("mutationStop");
    expect(r.pathTaken).toEqual(["a"]);
  });

  it("does NOT false-positive on JS arrow functions or >= comparisons in node -e", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [{
        id: "a",
        commands: [
          `node -e "const xs = [1,2,3]; xs.forEach(x => console.log(x))"`,
          `node -e "if (process.versions.node >= '18') console.log('ok')"`,
        ],
      }],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).not.toBe("mutationStop");
    expect(r.pathTaken).toContain("a");
  });

  it("does NOT false-positive on `>` comparisons inside single-quoted awk programs", async () => {
    // The exact case that tripped the hoopoff/mimo session: `awk '$1 > 200'`.
    const plan: PlanTree = {
      root: "a",
      nodes: [{
        id: "a",
        commands: ["find . -name '*.ts' -exec wc -l {} + | sort -rn | awk '$1 > 200 {print $2, $1}'"],
      }],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).not.toBe("mutationStop");
    expect(r.pathTaken).toEqual(["a"]);
  });

  it("does NOT false-positive on `>` inside [[ ]] tests or (( )) arithmetic", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [{
        id: "a",
        commands: ["bash -c 'x=5; [[ $x > 3 ]] && echo big'", "bash -c '(( 4 > 2 )) && echo yes'"],
      }],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).not.toBe("mutationStop");
    expect(r.pathTaken).toEqual(["a"]);
  });

  it("mutationStop block names the offending command and token", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo ok", "echo hi > out.txt"] }] };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("mutationStop");
    expect(r.transcript).toContain("command 2"); // 1-based index of the offending command
    expect(r.transcript).toContain("echo hi > out.txt");
  });

  it("still catches real destructive commands (rm, file redirect)", async () => {
    const redirectPlan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo hi > output.txt"] }] };
    expect((await runPlanTree(redirectPlan, { cwd })).stoppedReason).toBe("mutationStop");

    const cpPlan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["cp -r src/ dest/"] }] };
    expect((await runPlanTree(cpPlan, { cwd })).stoppedReason).toBe("mutationStop");

    // Destructive word inside single quotes must still be caught (only angle
    // brackets are neutralized in quoted spans, not the whole span).
    const quotedRm: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["sh -c 'rm -rf /tmp/x'"] }] };
    expect((await runPlanTree(quotedRm, { cwd })).stoppedReason).toBe("mutationStop");
  });

  it("mutationStop: `sed -i` in a node hard-stops before running", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["sed -i 's/a/b/' file.txt"] }] };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("mutationStop");
    expect(r.pathTaken).toEqual([]);
  });

  it("noEdgeMatch: transcript explains what each condition observed", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [
        {
          id: "a",
          commands: ["exit 3"],
          edges: [
            { when: { kind: "exitCode", op: "eq", value: 0 }, to: "build" },
            { when: { kind: "match", source: "stdout", regex: "ready" }, to: "retry" },
          ],
        },
        { id: "build", commands: ["echo build"] },
        { id: "retry", commands: ["echo retry"] },
      ],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.stoppedReason).toBe("noEdgeMatch");
    expect(r.transcript).toContain("No edge matched from node a:");
    expect(r.transcript).toContain("- → build: exit == 0 → false (exit was 3)");
    expect(r.transcript).toMatch(/- → retry: stdout =~ \/ready\/ → false \(no match in \d+-char stdout\)/);
  });

  it("plan.cwd: runs commands and resolves fileExists in the given dir", async () => {
    // process.cwd() is .../predexec; "core" is a real subdir with source files.
    const plan: PlanTree = {
      root: "a",
      cwd: "core",
      nodes: [
        {
          id: "a",
          commands: ["pwd"],
          edges: [{ when: { kind: "fileExists", path: "engine.ts" }, to: "found" }],
        },
        { id: "found", commands: ["echo IN_CORE"] },
      ],
    };
    const r = await runPlanTree(plan, { cwd });
    expect(r.pathTaken).toEqual(["a", "found"]); // fileExists resolved relative to cwd/core
    expect(r.transcript).toContain("/core");
    expect(r.transcript).toContain("IN_CORE");
  });

  it("rejects an absolute plan cwd before running any command", async () => {
    let toolCalls = 0;
    const r = await runPlanTree(
      { root: "a", cwd: "/tmp", nodes: [{ id: "a", commands: [{ tool: "read", path: "inside.txt" }] }] },
      {
        cwd,
        executeToolOp: async () => {
          toolCalls++;
          return { stdout: "unexpected", stderr: "", exitCode: 0 };
        },
      },
    );

    expect(r.stoppedReason).toBe("error");
    expect(r.transcript).toContain("cwd must be a relative directory inside the session root");
    expect(r.pathTaken).toEqual([]);
    expect(toolCalls).toBe(0);
  });

  it.each(["..", 123 as unknown as string])("rejects an invalid plan cwd (%s) before running any command", async (planCwd) => {
    let toolCalls = 0;
    const r = await runPlanTree(
      { root: "a", cwd: planCwd, nodes: [{ id: "a", commands: [{ tool: "read", path: "inside.txt" }] }] },
      {
        cwd,
        executeToolOp: async () => {
          toolCalls++;
          return { stdout: "unexpected", stderr: "", exitCode: 0 };
        },
      },
    );

    expect(r.stoppedReason).toBe("error");
    expect(r.transcript).toContain("cwd must be a relative directory inside the session root");
    expect(r.pathTaken).toEqual([]);
    expect(toolCalls).toBe(0);
  });

  it("resolves a nested plan cwd inside the session root", async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "predexec-cwd-"));
    try {
      const nested = join(sessionRoot, "sub");
      mkdirSync(nested);
      const resolved = resolvePlanCwd(sessionRoot, "sub");
      expect(resolved).toEqual({ cwd: nested });

      const r = await runPlanTree(
        { root: "a", cwd: "sub", nodes: [{ id: "a", commands: ["pwd"] }] },
        { cwd: sessionRoot },
      );
      expect(r.stoppedReason).toBe("leaf");
      expect(r.transcript).toContain(nested);
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });

  it("transcript: surfaces a cwd header and does NOT echo the raw command", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo body-output"] }] };
    const r = await runPlanTree(plan, { cwd });
    expect(r.transcript).toContain(`# cwd: ${cwd}`);
    expect(r.transcript).toContain("body-output"); // stdout still present
    expect(r.transcript).not.toContain("$ echo body-output"); // command not double-emitted
  });

  it("renders truncation warning from completeness flags, not marker text", async () => {
    const markerText = "echo '…[truncated]'";
    const r = await runPlanTree({ root: "a", nodes: [{ id: "a", commands: [markerText] }] }, { cwd });
    expect(r.transcript).toContain("…[truncated]");
    expect(r.transcript).not.toContain("⚠ Output truncated");
  });

  it("aborted: returns aborted when the signal is already set", async () => {
    const plan: PlanTree = { root: "a", nodes: [{ id: "a", commands: ["echo hi"] }] };
    const r = await runPlanTree(plan, { cwd, signal: AbortSignal.abort() });
    expect(r.stoppedReason).toBe("aborted");
    expect(r.fellBack).toBe(true);
  });
});

describe("runPlanTree — operation-wide policy", () => {
  it("checks every operation before any executor runs and formats native policy stops", async () => {
    const seen: unknown[] = [];
    let executed = false;
    const plan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: [{ tool: "read", path: ".env" }, "echo should-not-run"] }],
    };
    const r = await runPlanTree(plan, {
      cwd,
      executeToolOp: async () => {
        executed = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      checkOperationPolicy: (operation) => {
        seen.push(operation);
        return typeof operation === "object" && operation.tool === "read" ? "Read(./.env)" : null;
      },
    });
    expect(seen).toEqual([{ tool: "read", path: ".env" }, "echo should-not-run"]);
    expect(executed).toBe(false);
    expect(r.stoppedReason).toBe("policyStop");
    expect(r.transcript).toContain("read:.env");
    expect(r.transcript).toContain("'Read(./.env)'");
  });

  it("normalizes native paths for policy without prefixing find or grep patterns", async () => {
    const sessionRoot = mkdtempSync(join(tmpdir(), "predexec-policy-cwd-"));
    try {
      const seen: unknown[] = [];
      const r = await runPlanTree(
        {
          root: "a",
          cwd: "sub",
          nodes: [{
            id: "a",
            commands: [
              { tool: "read", path: ".env" },
              { tool: "ls", path: "." },
              { tool: "grep", path: "src", pattern: "ERROR" },
              { tool: "find", path: ".", pattern: "README.md" },
            ],
          }],
        },
        {
          cwd: sessionRoot,
          checkOperationPolicy: (operation) => (seen.push(operation), null),
          executeToolOp: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        },
      );
      expect(r.stoppedReason).toBe("leaf");
      expect(seen).toEqual([
        { tool: "read", path: "sub/.env" },
        { tool: "ls", path: "sub" },
        { tool: "grep", path: "sub/src", pattern: "ERROR" },
        { tool: "find", path: "sub", pattern: "README.md" },
      ]);
    } finally {
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  });

  it("passes shell strings and bash objects to the operation checker", async () => {
    const seen: unknown[] = [];
    const r = await runPlanTree(
      { root: "a", nodes: [{ id: "a", commands: ["echo hi", { tool: "bash", command: "printf ok" }] }] },
      {
        cwd,
        checkOperationPolicy: (operation) => {
          seen.push(operation);
          return null;
        },
      },
    );
    expect(r.stoppedReason).toBe("leaf");
    expect(seen).toEqual(["echo hi", { tool: "bash", command: "printf ok" }]);
  });
});

describe("validatePlan", () => {
  const v = (plan: PlanTree) => validatePlan(plan, new Map<string, PlanNode>());

  it("accepts a well-formed plan", () => {
    expect(v({ root: "a", nodes: [{ id: "a", commands: ["echo hi"] }] })).toBeNull();
  });

  it("rejects an empty node list", () => {
    expect(v({ root: "a", nodes: [] })).toMatch(/no nodes/);
  });

  it("rejects a missing root", () => {
    expect(v({ root: "z", nodes: [{ id: "a", commands: [] }] })).toMatch(/root/);
  });

  it("rejects duplicate ids", () => {
    expect(v({ root: "a", nodes: [{ id: "a", commands: [] }, { id: "a", commands: [] }] })).toMatch(/duplicate/);
  });

  it("rejects an edge to a missing node", () => {
    expect(
      v({ root: "a", nodes: [{ id: "a", commands: [], edges: [{ when: { kind: "always" }, to: "ghost" }] }] }),
    ).toMatch(/missing node/);
  });

  it("tier rule: a low-confidence (match) edge may not gate a mutating node", () => {
    const err = v({
      root: "a",
      nodes: [
        { id: "a", commands: [], edges: [{ when: { kind: "match", source: "stdout", regex: "ok" }, to: "w" }] },
        { id: "w", commands: ["echo x"], mutates: true },
      ],
    });
    expect(err).toMatch(/low-confidence/);
  });

  it("tier rule: a high-confidence edge MAY gate a mutating node", () => {
    expect(
      v({
        root: "a",
        nodes: [
          { id: "a", commands: [], edges: [{ when: { kind: "exitCode", op: "eq", value: 0 }, to: "w" }] },
          { id: "w", commands: ["echo x"], mutates: true },
        ],
      }),
    ).toBeNull();
  });

  it("runPlanTree returns stoppedReason 'error' on an invalid plan", async () => {
    const r = await runPlanTree({ root: "z", nodes: [{ id: "a", commands: [] }] }, { cwd });
    expect(r.stoppedReason).toBe("error");
    expect(r.transcript).toContain("validation failed");
  });

  it("rejects nodes over the 64-operation ceiling", async () => {
    const r = await runPlanTree(
      { root: "a", nodes: [{ id: "a", commands: Array.from({ length: 65 }, () => "true") }] },
      { cwd },
    );
    expect(r.stoppedReason).toBe("error");
    expect(r.transcript).toMatch(/64 operations/);
  });

  it("rejects a multi-operation node feeding a jsonPath edge before execution", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [
        {
          id: "a",
          commands: ["true", `printf '{"ok":true}'`],
          edges: [{ when: { kind: "jsonPath", path: "ok", op: "exists" }, to: "b" }],
        },
        { id: "b", commands: ["echo reached"] },
      ],
    };

    const r = await runPlanTree(plan, { cwd });

    expect(r.stoppedReason).toBe("error");
    expect(r.pathTaken).toEqual([]);
    expect(r.transcript).toContain("jsonPath edges require a one-operation source node.");
    expect(r.transcript).not.toContain("node a (exit");
  });

  it("allows a one-operation node feeding a jsonPath edge", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [
        {
          id: "a",
          commands: [`printf '{"ok":true}'`],
          edges: [{ when: { kind: "jsonPath", path: "ok", op: "exists" }, to: "b" }],
        },
        { id: "b", commands: ["echo reached"] },
      ],
    };

    const r = await runPlanTree(plan, { cwd });

    expect(r.stoppedReason).toBe("leaf");
    expect(r.pathTaken).toEqual(["a", "b"]);
    expect(r.transcript).toContain("reached");
  });
});

describe("runPlanTree — tool operations", () => {
  const opts: RunOptions = { cwd, executeToolOp: mockToolExecutor };

  it("executes a tool op in a leaf node", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: [{ tool: "read", path: "config.json" }] }],
    };
    const r = await runPlanTree(plan, opts);
    expect(r.stoppedReason).toBe("leaf");
    expect(r.transcript).toContain("file: config.json");
    expect(r.transcript).toContain("[read:config.json]");
  });

  it("branches on tool op output using match condition", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [
        {
          id: "a",
          commands: [{ tool: "read", path: "tsconfig.json" }],
          edges: [
            { when: { kind: "match", source: "stdout", regex: "strict.*true" }, to: "strict" },
            { when: { kind: "always" }, to: "loose" },
          ],
        },
        { id: "strict", commands: ["echo strict-mode"] },
        { id: "loose", commands: ["echo loose-mode"] },
      ],
    };
    const r = await runPlanTree(plan, opts);
    expect(r.pathTaken).toEqual(["a", "strict"]);
    expect(r.transcript).toContain("strict-mode");
  });

  it("mixes shell commands and tool ops in a multi-level tree", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [
        {
          id: "a",
          commands: [{ tool: "find", pattern: "*.ts" }],
          edges: [{ when: { kind: "match", source: "stdout", regex: "\\.ts" }, to: "b" }],
        },
        {
          id: "b",
          commands: ["echo found-ts-files"],
        },
      ],
    };
    const r = await runPlanTree(plan, opts);
    expect(r.pathTaken).toEqual(["a", "b"]);
    expect(r.transcript).toContain("found-ts-files");
  });

  it("hard-stops on edit tool op (mutating)", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: [{ tool: "edit", path: "foo.ts", edits: [] }] }],
    };
    const r = await runPlanTree(plan, opts);
    expect(r.stoppedReason).toBe("mutationStop");
    expect(r.transcript).toContain("HARD-STOP");
  });

  it("hard-stops on write tool op (mutating)", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: [{ tool: "write", path: "out.txt", content: "hi" }] }],
    };
    const r = await runPlanTree(plan, opts);
    expect(r.stoppedReason).toBe("mutationStop");
  });

  it("rejects unknown tool during structural validation", async () => {
    const plan: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: [{ tool: "deploy", target: "prod" }] }],
    };
    const r = await runPlanTree(plan, opts);
    expect(r.stoppedReason).toBe("error");
    expect(r.transcript).toContain("unknown tool");
  });

  it("read/grep/find/ls tool ops pass destructive check", async () => {
    for (const tool of ["read", "grep", "find", "ls"]) {
      const plan: PlanTree = {
        root: "a",
        nodes: [{ id: "a", commands: [{ tool, path: "test" }] }],
      };
      const r = await runPlanTree(plan, opts);
      expect(r.stoppedReason).not.toBe("mutationStop");
    }
  });

  it("bash tool op falls through to destructive regex check", async () => {
    const safe: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: [{ tool: "bash", command: "echo hello" }] }],
    };
    const r1 = await runPlanTree(safe, opts);
    expect(r1.stoppedReason).not.toBe("mutationStop");

    const dangerous: PlanTree = {
      root: "a",
      nodes: [{ id: "a", commands: [{ tool: "bash", command: "rm -rf /tmp/x" }] }],
    };
    const r2 = await runPlanTree(dangerous, opts);
    expect(r2.stoppedReason).toBe("mutationStop");
  });
});
