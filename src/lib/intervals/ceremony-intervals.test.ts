import { describe, it, expect } from "vitest";
import {
  ceremonySelectableIntervals,
  defaultCeremonyInterval,
} from "./ceremony-intervals";

/**
 * A sprint ceremony runs on a SPRINT. The board offered every interval in the
 * project, including the Program Increment — and because the API returns them
 * newest-number-first and a PI is ACTIVE for as long as anything inside it runs,
 * "the first ACTIVE interval" picked the PI. Opening the board showed a review
 * of PI-001 reading 0 points and 0/0 items, which is not a fact about the team.
 */

const iv = (
  number: number,
  name: string,
  status: "PLANNED" | "ACTIVE" | "COMPLETED",
  intervalKind = "SPRINT",
) => ({ id: `i${number}`, number, name, status, intervalKind });

/** How the API actually returns them: `orderBy: { number: "desc" }`. */
const asApiReturnsThem = <T extends { number: number }>(rows: T[]) =>
  [...rows].sort((a, b) => b.number - a.number);

describe("ceremonySelectableIntervals", () => {
  it("excludes Program Increments", () => {
    const rows = ceremonySelectableIntervals([
      iv(100, "PI-001", "ACTIVE", "PROGRAM_INCREMENT"),
      iv(1, "Sprint 1", "ACTIVE"),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Sprint 1"]);
  });

  it("keeps every non-PI iteration kind", () => {
    // The enum has eight kinds and only one of them is a container. A filter
    // written as an allowlist of "SPRINT" would silently empty the picker for a
    // project that runs PHASEs or ITERATIONs.
    const rows = ceremonySelectableIntervals([
      iv(1, "Iteration 1", "ACTIVE", "ITERATION"),
      iv(2, "Phase 2", "PLANNED", "PHASE"),
      iv(100, "PI-001", "ACTIVE", "PROGRAM_INCREMENT"),
    ]);
    expect(rows.map((r) => r.name)).toEqual(["Iteration 1", "Phase 2"]);
  });

  it("returns an empty list when a project has only a PI", () => {
    expect(
      ceremonySelectableIntervals([iv(100, "PI-001", "ACTIVE", "PROGRAM_INCREMENT")]),
    ).toEqual([]);
  });
});

describe("defaultCeremonyInterval", () => {
  it("picks the ACTIVE SPRINT even when an ACTIVE PI sorts ahead of it", () => {
    // THE BUG. A PI carries the highest number, so it arrives first and won
    // `.find(i => i.status === "ACTIVE")`. Both are ACTIVE here on purpose: a PI
    // is active for exactly as long as a sprint inside it is, so this is the
    // normal state of a healthy project, not an edge case.
    const picked = defaultCeremonyInterval(
      asApiReturnsThem([
        iv(1, "Sprint 1", "ACTIVE"),
        iv(100, "PI-001", "ACTIVE", "PROGRAM_INCREMENT"),
      ]),
    );
    expect(picked?.name).toBe("Sprint 1");
  });

  it("falls back to the most recently completed sprint", () => {
    const picked = defaultCeremonyInterval(
      asApiReturnsThem([
        iv(1, "Sprint 1", "COMPLETED"),
        iv(2, "Sprint 2", "COMPLETED"),
        iv(3, "Sprint 3", "PLANNED"),
      ]),
    );
    // A review is run on the sprint that just ended, not the one not yet begun.
    expect(picked?.name).toBe("Sprint 2");
  });

  it("falls back to the newest planned sprint when nothing has run yet", () => {
    const picked = defaultCeremonyInterval(
      asApiReturnsThem([iv(1, "Sprint 1", "PLANNED"), iv(2, "Sprint 2", "PLANNED")]),
    );
    expect(picked?.name).toBe("Sprint 2");
  });

  it("returns null rather than a PI when the project has no sprints", () => {
    // Returning the PI here would put the board straight back into the state
    // this function exists to prevent.
    expect(
      defaultCeremonyInterval([iv(100, "PI-001", "ACTIVE", "PROGRAM_INCREMENT")]),
    ).toBeNull();
  });

  it("returns null for an empty project", () => {
    expect(defaultCeremonyInterval([])).toBeNull();
  });
});
