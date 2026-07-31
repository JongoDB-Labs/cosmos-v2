import { describe, it, expect } from "vitest";
import { deriveMilestoneDueDate, type LinkedItemDate } from "./milestone-date";

// REPORTED: a milestone's date on the Milestones board does not follow the
// planned end date of the work item it came from.
//
// Milestone.autoStatus already means "this milestone follows its linked work" —
// deriveMilestone reads it to compute STATUS. The date never followed, so a
// milestone converted from a ticket (#489) kept whatever due date it was created
// with while the ticket moved, and the two projections silently disagreed.
//
// Same flag, extended to the thing it always implied.

const d = (iso: string) => new Date(iso);
const STORED = d("2026-03-01T00:00:00Z");

describe("deriveMilestoneDueDate", () => {
  it("follows the linked item's date", () => {
    const links: LinkedItemDate[] = [{ dueDate: d("2026-05-20T00:00:00Z") }];
    expect(deriveMilestoneDueDate(STORED, true, links)?.toISOString()).toBe(
      "2026-05-20T00:00:00.000Z",
    );
  });

  it("keeps the stored date when the milestone is not auto-managed", () => {
    // autoStatus false means someone took manual control; the date is theirs.
    const links: LinkedItemDate[] = [{ dueDate: d("2026-05-20T00:00:00Z") }];
    expect(deriveMilestoneDueDate(STORED, false, links)).toEqual(STORED);
  });

  it("keeps the stored date when nothing is linked", () => {
    expect(deriveMilestoneDueDate(STORED, true, [])).toEqual(STORED);
  });

  it("keeps the stored date when no linked item has one", () => {
    // Milestone.dueDate is NOT NULL, so there is nothing to fall back to.
    // Inventing a date would land on the timeline as if someone committed to it.
    expect(deriveMilestoneDueDate(STORED, true, [{ dueDate: null }])).toEqual(STORED);
  });

  it("takes the LATEST date across several linked items", () => {
    // The milestone is not met until all of its work is; the earliest date
    // would mark it reached while work remains.
    const links: LinkedItemDate[] = [
      { dueDate: d("2026-05-20T00:00:00Z") },
      { dueDate: d("2026-07-04T00:00:00Z") },
      { dueDate: d("2026-06-01T00:00:00Z") },
    ];
    expect(deriveMilestoneDueDate(STORED, true, links)?.toISOString()).toBe(
      "2026-07-04T00:00:00.000Z",
    );
  });

  it("ignores linked items with no date when others have one", () => {
    const links: LinkedItemDate[] = [{ dueDate: null }, { dueDate: d("2026-05-20T00:00:00Z") }];
    expect(deriveMilestoneDueDate(STORED, true, links)?.toISOString()).toBe(
      "2026-05-20T00:00:00.000Z",
    );
  });

  it("returns the stored instance unchanged when the derived date equals it", () => {
    // So a caller can compare by identity/time and skip a pointless write.
    const same = [{ dueDate: new Date(STORED.getTime()) }];
    expect(deriveMilestoneDueDate(STORED, true, same)?.getTime()).toBe(STORED.getTime());
  });
});
