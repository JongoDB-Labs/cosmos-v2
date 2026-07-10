// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { deriveInitialFilters, parseFilters } from "./filter-bar";

// deriveInitialFilters decides the board's initial cycle scope. The Sprint board
// passes the sprint being viewed as `initialCycleId`; that scope must be
// AUTHORITATIVE so the board shows only that sprint — even when a stale `cycle`
// is still pinned in the URL from a previously-viewed sprint (which is exactly
// what happens when the board is remounted to switch sprints).
describe("deriveInitialFilters", () => {
  it("seeds the cycle scope from initialCycleId when the URL has no cycle", () => {
    const filters = deriveInitialFilters(new URLSearchParams(""), "sprint-5");
    expect(filters.cycleId).toBe("sprint-5");
  });

  it("lets initialCycleId WIN over a cycle already pinned in the URL", () => {
    // Regression guard: previously the URL cycle won, so switching sprints (which
    // remounts the board while the URL still holds the old sprint) left the board
    // stuck on the old sprint — showing items from a sprint other than the one
    // indicated in the header.
    const filters = deriveInitialFilters(
      new URLSearchParams("cycle=old-sprint"),
      "new-sprint",
    );
    expect(filters.cycleId).toBe("new-sprint");
  });

  it("falls back to the URL cycle when no initialCycleId is given (standalone Kanban)", () => {
    const filters = deriveInitialFilters(new URLSearchParams("cycle=abc"));
    expect(filters.cycleId).toBe("abc");
  });

  it("leaves the cycle scope empty when neither the URL nor the caller pins one", () => {
    const filters = deriveInitialFilters(new URLSearchParams(""));
    expect(filters.cycleId).toBeNull();
  });

  it("preserves the other URL-encoded filters while forcing the cycle", () => {
    const filters = deriveInitialFilters(
      new URLSearchParams("q=login&priority=HIGH&cycle=old"),
      "sprint-1",
    );
    expect(filters.cycleId).toBe("sprint-1");
    expect(filters.search).toBe("login");
    expect(filters.priorities).toEqual(["HIGH"]);
    // Equivalent to parseFilters + the cycle override.
    expect(filters).toEqual({
      ...parseFilters(new URLSearchParams("q=login&priority=HIGH&cycle=old")),
      cycleId: "sprint-1",
    });
  });
});
