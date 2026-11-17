import { describe, it, expect } from "vitest";
import { isDoneStatus, isResolvedStatus } from "./done-state";

/**
 * `isResolvedStatus` is the status-only sibling of `isWorkItemResolved`: does
 * work in this status need doing, or is it settled — delivered OR abandoned?
 *
 * The pair it belongs to is the point. "Was this delivered" (`isDoneStatus`,
 * which drives velocity and committed-vs-completed) and "is this still
 * outstanding" (here, which drives carry-forward) are different questions, and a
 * cancelled item is the case where they disagree: no, and no. Reading one as the
 * other is what kept cancelled duplicates rolling into every next sprint
 * (COSMOS-246).
 */

const STATUSES = [
  { key: "todo", category: "TODO" },
  { key: "in_progress", category: "IN_PROGRESS" },
  { key: "done", category: "DONE" },
  { key: "shipped", category: "DONE" },
  { key: "cancelled", category: "CANCELLED" },
];

describe("isResolvedStatus", () => {
  it("is true for a cancelled status, where isDoneStatus is false", () => {
    // Both halves matter. Cancelled work is settled (so it does not carry) and
    // was not delivered (so it is not velocity) — see COSMOS-206.
    expect(isResolvedStatus("cancelled", STATUSES)).toBe(true);
    expect(isDoneStatus("cancelled", STATUSES)).toBe(false);
  });

  it("is true for everything isDoneStatus is true for", () => {
    expect(isResolvedStatus("done", STATUSES)).toBe(true);
    // A team-named done lane, done by its category rather than its key.
    expect(isResolvedStatus("shipped", STATUSES)).toBe(true);
  });

  it("is false for work that still needs doing", () => {
    expect(isResolvedStatus("todo", STATUSES)).toBe(false);
    expect(isResolvedStatus("in_progress", STATUSES)).toBe(false);
    expect(isResolvedStatus(null, STATUSES)).toBe(false);
    expect(isResolvedStatus(undefined, STATUSES)).toBe(false);
  });

  it("believes a known column's category over its name, as isDoneStatus does", () => {
    // A lane keyed "cancelled" that the team re-categorised to IN_PROGRESS is
    // live work. The same rule isWorkItemResolved follows for a renamed lane.
    const relabelled = [{ key: "cancelled", category: "IN_PROGRESS" }];
    expect(isResolvedStatus("cancelled", relabelled)).toBe(false);
  });

  it("falls back to the seeded Cancelled key for a status no board shows", () => {
    // board.columns is EMPTY on Timeline / Roadmap / Calendar / Table boards.
    expect(isResolvedStatus("cancelled", [])).toBe(true);
    expect(isResolvedStatus("Cancelled")).toBe(true);
    // Not a general key-sniff for abandonment: only the seeded lane's key.
    expect(isResolvedStatus("dropped", [])).toBe(false);
    expect(isResolvedStatus("wont-fix", [])).toBe(false);
    // ("abandoned" is already true through isDoneStatus, whose done-words match
    // as substrings and find "done" inside it. Pre-existing, not widened here.)
  });

  it("distrusts the TODO default, the category every uncategorised column gets", () => {
    // Stored as TODO because nothing ever set a category (templates, the
    // columns API) — the key still decides, exactly as in isDoneStatus.
    expect(isResolvedStatus("cancelled", [{ key: "cancelled", category: "TODO" }])).toBe(true);
    expect(isResolvedStatus("completed", [{ key: "completed", category: "TODO" }])).toBe(true);
  });
});
