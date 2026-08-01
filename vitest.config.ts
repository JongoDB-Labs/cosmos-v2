import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    // Vitest's default is 5s, which the DB-backed specs exceed under load — not
    // because anything hangs, but because ~390 test files share one Postgres and
    // a spec doing a dozen round-trips runs ~1s alone and 6-11s in a full run.
    //
    // That produced a genuinely intermittent failure (most often
    // ai/executors/work-items and ingest/items) which passed 9/9 in isolation
    // every time it was chased. Confirmed by forcing the timeout DOWN: at 250ms
    // exactly the DB-backed cases fail, with "Test timed out", and the pure ones
    // pass — the same signature as the intermittent failures.
    //
    // A random failure is worse than a slow suite: it trains everyone to re-run
    // rather than read, which is how a real regression gets waved through. 30s
    // still catches a genuine hang — those do not finish in 30s — while
    // tolerating contention.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: [
      // `.mts` so a composed plugin's daemon tests run (e.g. Foreman's
      // src/plugins/foreman/daemon/*.test.mts — moved here from scripts/foreman/ in
      // the ADR-0003 P3 extraction; the neutral core has no such files).
      "src/**/*.test.{ts,tsx,mts}",
      "scripts/cutover/**/*.test.{ts,mts}",
      "scripts/dsop/**/*.test.{ts,mts,mjs}",
      "scripts/plugins/**/*.test.{ts,mts,mjs}",
    ],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
