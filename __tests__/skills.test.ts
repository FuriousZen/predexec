/**
 * Single-source skill generation: every harness's routing SKILL.md is rendered
 * from steering.ts by `pnpm skills`. The committed files must equal the render
 * byte-for-byte, so a steering edit that forgets to regenerate fails here.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RECOVERY_LINE,
  SKILL_HARNESSES,
  SKILL_PATHS,
  STEERING_LINE,
  STEERING_MARKERS,
  USAGE_LINE,
  VERIFY_FIRST_LINE,
  WHEN_SYNTAX_LINE,
  renderSkill,
  systemHasRoutingInstructions,
} from "../steering.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MCP_ID = "mcp__predexec__predexec";
const VARIES_SENTENCE = /[^.\n]*\bvaries by install\b[^\n]*/g;

/** Minimal frontmatter reader: `---\nkey: value\n...\n---\n` → map + body. */
function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error("no frontmatter block");
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-z-]+): (.+)$/.exec(line);
    if (!kv) throw new Error(`unparseable frontmatter line: ${line}`);
    // A plain YAML scalar must not contain ": " or " #" or it re-parses differently.
    expect(kv[2]).not.toMatch(/: | #|^["'&*!|>%@`{[]/);
    fields[kv[1]] = kv[2];
  }
  return { fields, body: m[2] };
}

describe("skills — single source (steering.ts → SKILL.md)", () => {
  it("covers exactly the five harnesses, each at a distinct path", () => {
    expect([...SKILL_HARNESSES].sort()).toEqual(["antigravity", "claude", "codex", "opencode", "pi"]);
    const paths = SKILL_HARNESSES.map((h) => SKILL_PATHS[h]);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(p).toMatch(/\/SKILL\.md$/);
  });

  it.each(SKILL_HARNESSES)("%s: committed SKILL.md equals renderSkill (drift guard)", (h) => {
    const path = join(root, SKILL_PATHS[h]);
    expect(existsSync(path), `${SKILL_PATHS[h]} is missing — run pnpm skills`).toBe(true);
    expect(readFileSync(path, "utf8"), `${SKILL_PATHS[h]} is stale — run pnpm skills`).toBe(renderSkill(h));
  });

  it.each(SKILL_HARNESSES)("%s: frontmatter parses with a valid name and a routing description", (h) => {
    const { fields } = parseFrontmatter(renderSkill(h));
    expect(Object.keys(fields).sort()).toEqual(["description", "name"]);
    expect(fields.name).toBe("predexec");
    expect(fields.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(fields.description.length).toBeLessThanOrEqual(1024);
    expect(fields.description).toContain(STEERING_LINE);
    // The description alone must reach the STEERING_MARKERS quorum.
    expect(STEERING_MARKERS.filter((m) => fields.description.includes(m)).length).toBeGreaterThanOrEqual(2);
    expect(systemHasRoutingInstructions([fields.description])).toBe(true);
  });

  it.each(SKILL_HARNESSES)("%s: body is composed from the steering constants", (h) => {
    const { body } = parseFrontmatter(renderSkill(h));
    for (const line of [USAGE_LINE, VERIFY_FIRST_LINE, RECOVERY_LINE, WHEN_SYNTAX_LINE]) {
      expect(body).toContain(line.trim());
    }
    for (const op of ['{tool:"read"', '{tool:"grep"', '{tool:"find"', '{tool:"ls"']) expect(body).toContain(op);
    expect(body).toContain("mutationStop");
    expect(body).toMatch(/exit(?:ing)? 2\b/);
    expect(body).toMatch(/truncat/i);
  });

  it("pi omits policyStop; every other harness has a policy paragraph", () => {
    expect(renderSkill("pi")).not.toContain("policyStop");
    for (const h of SKILL_HARNESSES.filter((x) => x !== "pi")) expect(renderSkill(h)).toContain("policyStop");
    expect(renderSkill("claude")).toMatch(/deny.*ask|ask.*deny/);
    expect(renderSkill("opencode")).toMatch(/prompt/i);
    expect(renderSkill("codex")).toMatch(/execpolicy/);
    expect(renderSkill("antigravity")).toMatch(/Deny ?> ?Ask ?> ?Allow/);
  });

  it("opencode's ask sentence is version-accurate: 1.x may prompt, 2.x (no plugin ask) hard-stops", () => {
    // The same packaged skill is registered on both majors (v1 config hook,
    // v2 ctx.skill.transform), so it must not promise a prompt on 2.x.
    const body = renderSkill("opencode");
    expect(body).toMatch(/opencode 1\.x[^.]*prompt/i);
    expect(body).toMatch(/opencode 2\.x[^.]*(hard-)?stops?/i);
    // The pre-fix sentence promised a prompt with no version qualifier.
    expect(body).not.toContain("stops immediately (`policyStop`); an ask is forwarded");
  });

  it.each(SKILL_HARNESSES)("%s: never hardcodes the MCP tool id outside the 'varies by install' sentence", (h) => {
    const stripped = renderSkill(h).replace(VARIES_SENTENCE, "");
    expect(stripped).not.toContain(MCP_ID);
    expect(stripped).not.toMatch(/mcp__/);
  });

  it("package.json files ships the skills trees", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.files).toEqual(expect.arrayContaining(["skills", ".pi/skills", "antigravity-plugin"]));
    expect(pkg.scripts.skills).toBe("pnpm run build && node scripts/gen-skills.mjs");
  });

  it("npm pack lists every harness's SKILL.md and not the retired predexec-claude skill", () => {
    const out = execSync("npm pack --dry-run --json --ignore-scripts", {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const files: string[] = JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
    for (const h of SKILL_HARNESSES) expect(files).toContain(SKILL_PATHS[h]);
    expect(files.some((f) => f.includes("predexec-claude"))).toBe(false);
  }, 60_000);
});
