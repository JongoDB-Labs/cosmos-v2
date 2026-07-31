import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildCrumbs } from "./breadcrumbs";
import { slugify } from "@/lib/templates/slugify";

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
 * The list is read from source because the route file does not export it, and
 * widening a route module's export surface to satisfy a test is the wrong
 * trade. `slugify` is imported for real — reimplementing it here would let the
 * test pass while the app slugged differently.
 */
describe("every built-in board name survives the breadcrumb round-trip", () => {
  const ROUTE = "src/app/api/v1/orgs/[orgId]/templates/built-in/route.ts";
  const src = readFileSync(ROUTE, "utf8");

  // Kanban COLUMN names ("Open", "In Progress") live in this same file inside
  // `config.columns` and are never URL segments. A column literal carries
  // `key:` and `color:` on its line; a board name never does.
  const names = src
    .split("\n")
    .filter((line) => !(line.includes("key:") && line.includes("color:")))
    .flatMap((line) => [...line.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]));

  it("found the built-in board list", () => {
    // Guards the guard: a moved file or changed shape must fail loudly rather
    // than iterate an empty list and report success.
    expect(src.length).toBeGreaterThan(1000);
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
