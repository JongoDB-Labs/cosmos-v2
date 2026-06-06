import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // The flaky dnd-kit drag journey lives under e2e/interaction/ and is
  // EXCLUDED from the default (gated `e2e`) run. Only the informational,
  // non-gating `e2e-interaction` CI job opts in by setting
  // E2E_INCLUDE_INTERACTION=1 (which removes this ignore). testIgnore is
  // applied at collection time against the absolute path, so a bare
  // `playwright test e2e/interaction/...` path arg would still be filtered
  // out without the env opt-in — hence the env gate.
  testIgnore: process.env.E2E_INCLUDE_INTERACTION
    ? undefined
    : ["interaction/**"],
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
