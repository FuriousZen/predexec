import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
    environment: "node",
    globalSetup: ["__tests__/helpers/global-setup.ts"],
    env: {
      // Tests execute real plans through executeAdapterPlan, whose stats
      // recorder appends to the live ~/.local/state/predexec/stats.jsonl
      // unless redirected. Pin the whole suite (and every child process the
      // pack tests spawn) to a throwaway dir. Tests that exercise state-dir
      // resolution override or delete this locally.
      PREDEXEC_STATE_DIR: mkdtempSync(join(tmpdir(), "predexec-test-stats-")),
      // The adapter runtime loads the user's classifier config (user-config.ts)
      // on every plan run. Pin it to an empty dir and blank the env opt-ins so
      // the real ~/.config/predexec never changes a test's verdict.
      XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "predexec-test-config-")),
      PREDEXEC_ALLOW_SCRIPTS: "",
      PREDEXEC_READONLY_HEADS: "",
    },
  },
});
