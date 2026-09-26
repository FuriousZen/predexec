import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, it } from "vitest";

it("core/ imports nothing outside core/", () => {
  const root = resolve("core");
  const bad: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) {
        // Module specifiers of static import/export statements and dynamic
        // import() calls; `from "..."` inside message strings is not an import.
        const source = readFileSync(p, "utf8");
        const specifiers = [
          ...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm),
          ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
          ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
        ];
        for (const m of specifiers) {
          const spec = m[1]!;
          if (!spec.startsWith(".")) {
            if (!spec.startsWith("node:")) bad.push(`${p}: ${spec}`);
            continue;
          }
          if (relative(root, resolve(d, spec)).startsWith("..")) bad.push(`${p}: ${spec}`);
        }
      }
    }
  };
  walk(root);
  expect(bad).toEqual([]);
});
