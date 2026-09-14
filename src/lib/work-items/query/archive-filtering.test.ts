import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorkItemWhere } from "./build-where";
import { parseSearchParams } from "./parse";

/**
 * Archived work items stay out of the way unless asked for.
 *
 * The rule has to hold in TWO places, because work items are read through two
 * different queries: the shared `buildWorkItemWhere` (Issues, search, export,
 * facets, the single-row deep link, the org-scoped API) and the project-scoped
 * board route, which builds its own `where` inline for kanban/table/backlog/
 * timeline. A rule stated once and applied in one of two places is how an
 * archived duplicate reappears on the board it was archived from.
 */

const BOARD_ROUTE = readFileSync(
  join(
    process.cwd(),
    "src/app/api/v1/orgs/[orgId]/projects/[projectId]/work-items/route.ts",
  ),
  "utf8",
);

const base = { orgId: "o1", allowedProjectIds: ["p1"] };

describe("buildWorkItemWhere — the shared path", () => {
  it("hides archived items by default", () => {
    const where = buildWorkItemWhere({ ...base, filter: {} });
    expect(where.archivedAt).toBeNull();
  });

  it("shows them when explicitly asked", () => {
    const where = buildWorkItemWhere({ ...base, filter: { includeArchived: true } });
    // Not `null` — the constraint must be ABSENT, so both active and archived
    // rows match. Asserting `!== null` alone would pass on `undefined` from a
    // typo'd key, so pin the property is gone.
    expect(where.archivedAt).toBeUndefined();
  });

  it("keeps hiding them alongside other filters", () => {
    // The clause must survive being combined — an implementation that set
    // `where.archivedAt` before a later spread would lose it.
    const where = buildWorkItemWhere({
      ...base,
      filter: { priorities: ["HIGH"], columnKeys: ["todo"] },
    });
    expect(where.archivedAt).toBeNull();
    expect(where.orgId).toBe("o1");
  });

  it("still scopes to the allowed projects when showing archived", () => {
    // Un-hiding must not become a way around RBAC.
    const where = buildWorkItemWhere({
      ...base,
      filter: { includeArchived: true, projectIds: ["p1", "p-not-allowed"] },
    });
    expect(where.projectId).toEqual({ in: ["p1"] });
  });
});

describe("the opt-in is exactly '1'", () => {
  const parse = (qs: string) => parseSearchParams(new URLSearchParams(qs));

  it("turns on for ?includeArchived=1", () => {
    expect(parse("includeArchived=1").filter.includeArchived).toBe(true);
  });

  it("stays off for absent, 'false', 'true' and '0'", () => {
    // A loose truthy check would read `includeArchived=false` as ON and quietly
    // un-hide everything for anyone who guessed the wrong value.
    for (const qs of ["", "includeArchived=false", "includeArchived=true", "includeArchived=0"]) {
      expect(parse(qs).filter.includeArchived, qs || "(absent)").toBe(false);
    }
  });
});

describe("the board route filters archived too", () => {
  // Source-level, because this route builds its `where` inline rather than
  // through the shared builder — there is no exported unit to call.
  it("constrains archivedAt", () => {
    expect(BOARD_ROUTE).toContain("where.archivedAt = null");
  });

  it("gates that on the same explicit opt-in", () => {
    expect(BOARD_ROUTE).toMatch(/includeArchived["']?\)\s*!==\s*["']1["']/);
  });

  it("the assertion above would have caught the unfiltered route", () => {
    // Positive control: without it, a route that never mentions archivedAt
    // passes every other test in this file, because none of them execute it.
    const withoutRule = BOARD_ROUTE.replace(/if \(sp\.get\("includeArchived"\) !== "1"\) where\.archivedAt = null;/, "");
    expect(withoutRule).not.toContain("where.archivedAt = null");
  });
});
