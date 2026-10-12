// @vitest-environment node
//
// Two pieces of dead weight the nightly sweep found under src/app/(dashboard),
// pinned so they cannot grow back:
//
//  1. An org-level `/{orgSlug}/pm-dashboard` route that nothing linked to. It
//     was absent from nav-config, topbar-nav, mobile-nav and the command
//     palette, and every other pm-dashboard reference in src/ and e2e/ is the
//     project-scoped `/projects/<key>/pm-dashboard` path — so the portfolio
//     roll-up it rendered was reachable only by typing the URL. Deleted rather
//     than linked: the nav files are a separate surface and nobody asked for
//     the entry. Its removal left `DashboardScope`'s `kind: "org"` arm with no
//     constructor, so that went too.
//  2. `templateDefaultConfig` — declared on ProjectBoardTabsProps and passed in
//     by the project layout (which queried `projectTemplate.defaultConfig` to
//     feed it), but never destructured in the component. A whole Prisma join,
//     serialized across the server/client boundary, and dropped on arrival.
//
// A source-level check is the honest shape here: the defect is "this code
// exists and nothing reaches it", which no amount of rendering can observe.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("the org-level pm-dashboard route", () => {
  it("does not exist", () => {
    expect(existsSync(join(ROOT, "src/app/(dashboard)/[orgSlug]/pm-dashboard"))).toBe(
      false,
    );
  });

  it("leaves DashboardScope with no org arm to construct", () => {
    const src = read("src/components/pm-dashboard/pm-dashboard.tsx");
    expect(src).not.toContain('kind: "org"');
  });
});

describe("the project board tabs", () => {
  const TABS = "src/app/(dashboard)/[orgSlug]/projects/[projectKey]/board-tabs.tsx";
  const LAYOUT = "src/app/(dashboard)/[orgSlug]/projects/[projectKey]/layout.tsx";

  it("declares no templateDefaultConfig prop", () => {
    expect(read(TABS)).not.toContain("templateDefaultConfig");
  });

  it("is not fed a project template the layout had to join for", () => {
    const layout = read(LAYOUT);
    expect(layout).not.toContain("templateDefaultConfig");
    expect(layout).not.toContain("projectTemplate");
  });
});
