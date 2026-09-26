import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { findDestructiveToken, isDestructiveCommand } from "../../core/destructive.ts";

/**
 * Behavior lock for the classifier. The fixture is every string literal in
 * __tests__/** (extracted with the TypeScript parser), so it covers each
 * command the suites exercise plus plenty of non-command text. The snapshot
 * records findDestructiveToken's exact result for each; a refactor of
 * core/destructive.ts must leave it byte-for-byte unchanged.
 */
const corpus: string[] = JSON.parse(
  readFileSync(new URL("../fixtures/command-corpus.json", import.meta.url), "utf8"),
);

it("classifies the command corpus exactly as recorded", () => {
  const verdicts: Record<string, string | null> = {};
  for (const command of corpus) {
    const token = findDestructiveToken(command);
    expect(isDestructiveCommand(command)).toBe(token !== null);
    verdicts[command] = token;
  }
  expect(verdicts).toMatchSnapshot();
});
