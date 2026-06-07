import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Dedicated config for the Docker ACCEPTANCE suite (scripts/acceptance/**). These tests run
// against the REAL containerized Postgres (docker-compose.acceptance.yml) and are NOT part of
// the default `npm test` run (which must stay DB-free / hermetic). Invoke explicitly:
//   DATABASE_URL=... npx vitest run --config vitest.acceptance.config.ts
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    include: ["scripts/acceptance/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
