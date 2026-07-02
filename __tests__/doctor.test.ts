import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkNodeVersion,
  checkOpencode,
  checkPi,
  findOpencodeConfig,
  parseStatsLines,
  summarizeStats,
} from "../bin/predexec.mjs";

let tmp: string;
const scratch = () => (tmp = mkdtempSync(join(tmpdir(), "px-doctor-")));
afterEach(() => tmp && rmSync(tmp, { recursive: true, force: true }));

const write = (rel: string, content: string) => {
  const path = join(tmp, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

describe("doctor — node version", () => {
  it("passes on >=22, fails below", () => {
    expect(checkNodeVersion("22.1.0").status).toBe("ok");
    expect(checkNodeVersion("18.19.0").status).toBe("fail");
  });
});

describe("doctor — pi checks", () => {
  it("skips when pi is not configured", () => {
    scratch();
    expect(checkPi(join(tmp, "nope"))[0]!.status).toBe("skip");
  });

  it("passes with settings entry + installed package + zod", () => {
    scratch();
    write("settings.json", JSON.stringify({ packages: ["npm:predexec"] }));
    write("npm/node_modules/predexec/package.json", JSON.stringify({ version: "0.1.3" }));
    write("npm/node_modules/zod/package.json", JSON.stringify({ version: "4.1.8" }));
    const checks = checkPi(tmp);
    expect(checks.every((c) => c.status === "ok")).toBe(true);
    expect(checks.map((c) => c.name).join()).toContain("predexec@0.1.3");
  });

  it("fails when the settings entry or zod is missing", () => {
    scratch();
    write("settings.json", JSON.stringify({ packages: [] }));
    write("npm/node_modules/predexec/package.json", JSON.stringify({ version: "0.1.3" }));
    const statuses = checkPi(tmp).map((c) => c.status);
    expect(statuses).toContain("fail"); // settings entry AND zod both fail
    expect(statuses.filter((s) => s === "fail")).toHaveLength(2);
  });
});

describe("doctor — opencode checks", () => {
  const GOOD_PLUGIN = "export const server = 1;\nexport default { id: 'predexec', server };\n";
  const OLD_PLUGIN = "export const server = 1;\n"; // pre-0.1.1: named export only

  const setupCache = (pluginSrc: string, withZod: boolean) => {
    write(
      "cache/predexec@latest/node_modules/predexec/package.json",
      JSON.stringify({ version: "0.1.3" }),
    );
    write("cache/predexec@latest/node_modules/predexec/.opencode/plugins/predexec.ts", pluginSrc);
    if (withZod) {
      write("cache/predexec@latest/node_modules/zod/package.json", JSON.stringify({ version: "4.1.8" }));
    }
  };

  it("skips when no opencode.json exists anywhere", () => {
    scratch();
    const checks = checkOpencode({ cwd: join(tmp, "proj"), home: join(tmp, "home"), cacheRoot: join(tmp, "cache") });
    expect(checks[0]!.status).toBe("skip");
  });

  it("finds project config before global config", () => {
    scratch();
    write("proj/opencode.json", JSON.stringify({ plugin: ["predexec"] }));
    write("home/.config/opencode/opencode.json", JSON.stringify({ plugin: [] }));
    const found = findOpencodeConfig(join(tmp, "proj"), join(tmp, "home"));
    expect(found?.path).toBe(join(tmp, "proj", "opencode.json"));
  });

  it("all green with entry + cached install + zod + default export", () => {
    scratch();
    write("home/.config/opencode/opencode.json", JSON.stringify({ plugin: ["predexec"] }));
    setupCache(GOOD_PLUGIN, true);
    const checks = checkOpencode({ cwd: join(tmp, "proj"), home: join(tmp, "home"), cacheRoot: join(tmp, "cache") });
    expect(checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("flags a pre-0.1.1 cached plugin (no default export) and missing zod", () => {
    scratch();
    write("home/.config/opencode/opencode.json", JSON.stringify({ plugin: ["predexec"] }));
    setupCache(OLD_PLUGIN, false);
    const checks = checkOpencode({ cwd: join(tmp, "proj"), home: join(tmp, "home"), cacheRoot: join(tmp, "cache") });
    const fails = checks.filter((c) => c.status === "fail").map((c) => c.name);
    expect(fails.join()).toContain("zod");
    expect(fails.join()).toContain("export shape");
  });

  it("fails on config without the plugin entry", () => {
    scratch();
    write("home/.config/opencode/opencode.json", JSON.stringify({ plugin: ["context-mode"] }));
    const checks = checkOpencode({ cwd: join(tmp, "proj"), home: join(tmp, "home"), cacheRoot: join(tmp, "cache") });
    expect(checks[0]!.status).toBe("fail");
  });
});

describe("stats aggregation", () => {
  it("parses JSONL tolerantly and summarizes", () => {
    const lines = [
      JSON.stringify({ v: 1, harness: "pi", stoppedReason: "leaf", depthReached: 2, nodes: 3, ops: 5, edgesEvaluated: 3, edgesMatched: 2, requestsSaved: 4 }),
      "not json",
      JSON.stringify({ v: 1, harness: "opencode", stoppedReason: "noEdgeMatch", depthReached: 0, nodes: 1, ops: 2, edgesEvaluated: 1, edgesMatched: 0, requestsSaved: 1 }),
      JSON.stringify({ v: 99, harness: "future" }),
    ].join("\n");
    const records = parseStatsLines(lines);
    expect(records).toHaveLength(2);
    const s = summarizeStats(records);
    expect(s).toMatchObject({
      runs: 2,
      byHarness: { pi: 1, opencode: 1 },
      byStoppedReason: { leaf: 1, noEdgeMatch: 1 },
      ops: 7,
      requestsSaved: 5,
      edgesEvaluated: 4,
      edgesMatched: 2,
      avgDepth: 1,
    });
  });
});
