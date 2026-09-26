/**
 * Write every harness's routing SKILL.md from the single source in steering.ts.
 *
 * Run via `pnpm skills` (which builds first): this imports the COMPILED
 * `dist/steering.js`, so plain node needs no TypeScript loader. Never edit a
 * generated SKILL.md by hand — __tests__/skills.test.ts compares each file to
 * `renderSkill` and fails on drift. Dev-only: `scripts/` is not in `files`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { SKILL_HARNESSES, SKILL_PATHS, renderSkill } = await import(pathToFileURL(join(root, "dist", "steering.js")).href);

for (const h of SKILL_HARNESSES) {
  const path = join(root, SKILL_PATHS[h]);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderSkill(h), "utf8");
  console.log(`wrote ${SKILL_PATHS[h]}`);
}
