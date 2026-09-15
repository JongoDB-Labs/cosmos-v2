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

  it("shows ONLY archived for archived=only — what the toggle is named for", () => {
    // The shipped first cut made the "Archived" control an INCLUDE toggle, so
    // switching it on changed nothing visible on a board with three active
    // items and one archived. A filter named after a state selects that state.
    const where = buildWorkItemWhere({ ...base, filter: { archived: "only" } });
    expect(where.archivedAt).toEqual({ not: null });
  });

  it("shows both for archived=all", () => {
    const where = buildWorkItemWhere({ ...base, filter: { archived: "all" } });
    // Not `null` — the constraint must be ABSENT, so both active and archived
    // rows match. Asserting `!== null` alone would pass on `undefined` from a
    // typo'd key, so pin that the property is gone.
    expect(where.archivedAt).toBeUndefined();
  });

  it("treats an explicit 'active' the same as the default", () => {
    expect(buildWorkItemWhere({ ...base, filter: { archived: "active" } }).archivedAt).toBeNull();
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
      filter: { archived: "all", projectIds: ["p1", "p-not-allowed"] },
    });
    expect(where.projectId).toEqual({ in: ["p1"] });
  });
});

describe("the archive mode is parsed strictly", () => {
  const parse = (qs: string) => parseSearchParams(new URLSearchParams(qs)).filter.archived;

  it("reads ?archived=only and ?archived=all", () => {
    expect(parse("archived=only")).toBe("only");
    expect(parse("archived=all")).toBe("all");
  });

  it("defaults to active, including for junk values", () => {
    for (const qs of ["", "archived=", "archived=yes", "archived=true", "archived=ONLY"]) {
      expect(parse(qs), qs || "(absent)").toBe("active");
    }
  });

  it("still honours ?includeArchived=1, which shipped first, as 'all'", () => {
    // Back-compat, not a second way of saying the same thing: that param went
    // out in a release and may already be in someone's script.
    expect(parse("includeArchived=1")).toBe("all");
  });

  it("does NOT read includeArchived=false as truthy", () => {
    expect(parse("includeArchived=false")).toBe("active");
    expect(parse("includeArchived=0")).toBe("active");
  });

  it("lets the explicit mode win over the legacy alias", () => {
    expect(parse("includeArchived=1&archived=only")).toBe("only");
  });
});

describe("the board route filters archived too", () => {
  // Source-level, because this route builds its `where` inline rather than
  // through the shared builder — there is no exported unit to call.
  it("constrains archivedAt", () => {
    expect(BOARD_ROUTE).toContain("where.archivedAt = null");
  });

  it("selects archived on ?archived=only, the same word the shared builder uses", () => {
    expect(BOARD_ROUTE).toContain('where.archivedAt = { not: null }');
    expect(BOARD_ROUTE).toMatch(/archivedMode === "only"/);
  });

  it("still honours the ?includeArchived=1 alias that shipped first", () => {
    expect(BOARD_ROUTE).toMatch(/includeArchived["']?\)\s*!==\s*["']1["']/);
  });

  it("the assertions above would have caught an unfiltered route", () => {
    // Positive control: without it, a route that never mentions archivedAt
    // passes every other test in this file, because none of them execute it.
    // Strip every archivedAt constraint and the checks must have nothing left.
    const withoutRule = BOARD_ROUTE.replace(/where\.archivedAt = [^;]+;/g, "");
    expect(withoutRule).not.toContain("where.archivedAt =");
  });
});
