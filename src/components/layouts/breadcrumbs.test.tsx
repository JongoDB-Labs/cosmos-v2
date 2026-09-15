import { describe, expect, it } from "vitest";
import { buildCrumbs } from "./breadcrumbs";
import { slugify } from "@/lib/templates/slugify";
import { BUILT_IN_BOARD_TEMPLATES } from "@/lib/boards/built-in-templates";

describe("buildCrumbs", () => {
  it("returns empty for root", () => {
    expect(buildCrumbs("/", [])).toEqual([]);
  });

  it("maps org slug to org name", () => {
    const orgs = [{ slug: "fsc", name: "Fighting Smart Cyber" }];
    expect(buildCrumbs("/fsc", orgs)).toEqual([
      { label: "Fighting Smart Cyber", href: "/fsc" },
    ]);
  });

  it("titlecases subsequent segments", () => {
    const orgs = [{ slug: "fsc", name: "Fighting Smart Cyber" }];
    expect(buildCrumbs("/fsc/time-tracking", orgs)).toEqual([
      { label: "Fighting Smart Cyber", href: "/fsc" },
      { label: "Time Tracking", href: "/fsc/time-tracking" },
    ]);
  });

  it("returns org chip even when no match found", () => {
    expect(buildCrumbs("/unknown", [])).toEqual([
      { label: "unknown", href: "/unknown" },
    ]);
  });

  it("applies acronym overrides instead of naive title-casing", () => {
    const orgs = [{ slug: "fsc", name: "Fighting Smart Cyber" }];
    expect(buildCrumbs("/fsc/crm", orgs)).toEqual([
      { label: "Fighting Smart Cyber", href: "/fsc" },
      { label: "CRM", href: "/fsc/crm" },
    ]);
  });

  it("applies multi-word overrides (pm-dashboard → PM Dashboard, not Pm Dashboard)", () => {
    const orgs = [{ slug: "fsc", name: "Fighting Smart Cyber" }];
    expect(buildCrumbs("/fsc/projects/SENTINEL/pm-dashboard", orgs)).toEqual([
      { label: "Fighting Smart Cyber", href: "/fsc" },
      { label: "Projects", href: "/fsc/projects" },
      { label: "SENTINEL", href: "/fsc/projects/SENTINEL" },
      { label: "PM Dashboard", href: "/fsc/projects/SENTINEL/pm-dashboard" },
    ]);
  });

  it("labels the OKR View board as the tab spells it, not 'Okr View'", () => {
    // The reported defect. A board's URL segment is its slug, so this crumb sat
    // next to a tab reading "OKR View" and disagreed with it.
    const orgs = [{ slug: "fsc", name: "Fighting Smart Cyber" }];
    const crumbs = buildCrumbs("/fsc/projects/SENTINEL/boards/okr-view", orgs);
    expect(crumbs.at(-1)).toEqual({
      label: "OKR View",
      href: "/fsc/projects/SENTINEL/boards/okr-view",
    });
  });
});

/**
 * Derived from the built-in board list rather than hand-written, so it cannot
 * drift: adding a built-in board whose name carries an acronym or punctuation
 * fails HERE until `LABEL_OVERRIDES` gains an entry.
 *
 * The list used to be scraped from the route's source, because the route did
 * not export it and widening a route module's export surface for a test is the
 * wrong trade. The catalogue now lives in its own lib module with a real
 * export, so this imports it — no regex, and moving a file can no longer make
 * this test quietly iterate the wrong list. `slugify` is imported for real too;
 * reimplementing it here would let the test pass while the app slugged
 * differently.
 */
describe("every built-in board name survives the breadcrumb round-trip", () => {
  const names = BUILT_IN_BOARD_TEMPLATES.map((t) => t.name);

  it("found the built-in board list", () => {
    // Guards the guard: an empty or truncated list must fail loudly rather than
    // iterate nothing and report success.
    expect(names.length).toBeGreaterThan(10);
    expect(names).toContain("OKR View");
  });

  it("labels each one exactly as the board is named", () => {
    const orgs = [{ slug: "fsc", name: "FSC" }];
    const wrong: { name: string; slug: string; label: string }[] = [];

    for (const name of names) {
      const slug = slugify(name);
      if (!slug) continue;
      const crumbs = buildCrumbs(`/fsc/projects/P/boards/${slug}`, orgs);
      const label = crumbs.at(-1)?.label ?? "";
      if (label !== name) wrong.push({ name, slug, label });
    }

    expect(wrong).toEqual([]);
  });
});
