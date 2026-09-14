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

  it("keeps the mount inside a Suspense boundary", () => {
    // It calls useSearchParams(), and Next's docs are unconditional: that hook
    // ALWAYS needs a boundary. Without one, calling it opts "the Client
    // Component tree up to the closest Suspense boundary" out of prerendering —
    // and from THIS layout that tree is every org route in the product.
    //
    // The previous shape had the boundary and lost it while fixing something
    // else; nothing failed, because the cost does not show up as an error.
    // Comments are stripped FIRST. The doc comment beside the mount explains
    // why the boundary is there and quotes "<Suspense>" while doing it — and a
    // naive count读 those as real boundaries, so the check passed against the
    // very shape it exists to reject. Verified by reverting the layout: it must
    // fail, and it does.
    const code = layout
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const mountAt = code.indexOf("<TourMount />");
    expect(mountAt).toBeGreaterThan(-1);
    const before = code.slice(0, mountAt);
    const opens = (before.match(/<Suspense\b/g) ?? []).length;
    const closes = (before.match(/<\/Suspense>/g) ?? []).length;
    expect(
      opens - closes,
      "<TourMount /> must sit inside an open <Suspense> boundary",
    ).toBeGreaterThan(0);
  });

  it("does not resolve the session in the layout", () => {
    expect(layout).not.toContain("getAuthContext");
  });

  it("keeps the mount a client component that reads org from context", () => {
    expect(mount.trimStart().startsWith('"use client"')).toBe(true);
    expect(mount).toContain("usePermissions()");
  });
});
