import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const layout = readFileSync(
  join(root, "src/app/(dashboard)/[orgSlug]/layout.tsx"),
  "utf8",
);
const mount = readFileSync(
  join(root, "src/components/tour/tour-mount.tsx"),
  "utf8",
);

// This layout sits above EVERY org route. An awaited data read here is an
// uncached read during prerendering, and Next fails the prerender for all of
// them at once — accounting, invoices, payroll, settings. It cost a red e2e
// run, and the symptom (a chat spec timing out) points nowhere near the cause.
describe("org layout keeps the walkthrough client-side", () => {
  it("mounts the tour without passing it server-resolved props", () => {
    expect(layout).toContain("<TourMount />");
    // A prop would mean something upstream had to resolve it on the server.
    expect(layout).not.toMatch(/<TourMount\s+[^/>]/);
  });

  it("does not resolve the session in the layout", () => {
    expect(layout).not.toContain("getAuthContext");
  });

  it("keeps the mount a client component that reads org from context", () => {
    expect(mount.trimStart().startsWith('"use client"')).toBe(true);
    expect(mount).toContain("usePermissions()");
  });
});
