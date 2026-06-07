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
      "src/**/*.test.{ts,tsx}",
      "scripts/cutover/**/*.test.{ts,mts}",
      "scripts/dsop/**/*.test.{ts,mts,mjs}",
    ],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
