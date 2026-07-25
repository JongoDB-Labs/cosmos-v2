import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    include: [
      // `.mts` so a composed plugin's daemon tests run (e.g. Foreman's
      // src/plugins/foreman/daemon/*.test.mts — moved here from scripts/foreman/ in
      // the ADR-0003 P3 extraction; the neutral core has no such files).
      "src/**/*.test.{ts,tsx,mts}",
      "scripts/cutover/**/*.test.{ts,mts}",
      "scripts/dsop/**/*.test.{ts,mts,mjs}",
    ],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
