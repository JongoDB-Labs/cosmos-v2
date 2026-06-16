import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// The app-shell brand surface migrated in Foundation Plan 1. These files must
// resolve the brand via getBrand()/ProductProfile, never a hardcoded literal.
// (The literal legitimately lives in src/lib/product/profiles.ts only.)
const MIGRATED = [
  "src/app/layout.tsx",
  "src/app/manifest.ts",
  "src/components/brand/brand-mark.tsx",
  "src/components/brand/brand-logo.tsx",
  "src/components/layouts/floating-agent-bubble.tsx",
  "src/components/wake-word/wake-word-provider.tsx",
  "src/app/login/page.tsx",
];

describe("brand literals", () => {
  it("migrated brand-surface files contain no hardcoded COSMOS literal", () => {
    const offenders = MIGRATED.filter((rel) =>
      /COSMOS/.test(readFileSync(join(process.cwd(), rel), "utf8")),
    );
    expect(
      offenders,
      `Use getBrand() instead of a hardcoded brand literal in:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the static web manifest was replaced by app/manifest.ts", () => {
    expect(existsSync(join(process.cwd(), "public/manifest.webmanifest"))).toBe(false);
    expect(existsSync(join(process.cwd(), "src/app/manifest.ts"))).toBe(true);
  });
});
