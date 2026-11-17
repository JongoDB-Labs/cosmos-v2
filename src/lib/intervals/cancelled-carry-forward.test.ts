import { describe, it, expect } from "vitest";
import { resolveCarriedItems } from "./ceremony-carried";
import { buildIntervalReport } from "./interval-report";
import { computeSprintReview } from "./sprint-review";

/**
 * Cancelled duplicates do not carry forward (COSMOS-246).
 *
 * A team put a PI's stories into Cosmos twice, cancelled the copies as
 * duplicates, and watched them come back on the Sprint Retrospective's "work to
 * carry forward" — sprint after sprint, because carry-forward asked "was this
 * DELIVERED" and treated the answer as "is this still OUTSTANDING". For
 * cancelled work both answers are no. Merging duplicates (COSMOS-207) makes this
 * routine: the loser stays Cancelled ON ITS SPRINT, so every merge fed the list.
 *
 * The other half, pinned here too: the sprint's COMMITMENT does not move.
 * Committed points and the completion percentage still count every item the team
 * took on, duplicates included, because that is what was committed at planning —
 * before anyone knew. Only the outstanding set shrinks.
 */

// A project's statuses, as a board stores them. "shipped" is a team-named done
// lane; "cancelled" is the lane COSMOS-206 seeds.
const STATUSES = [
  { key: "todo", category: "TODO" },
  { key: "in_progress", category: "IN_PROGRESS" },
  { key: "done", category: "DONE" },
  { key: "shipped", category: "DONE" },
  { key: "cancelled", category: "CANCELLED" },
];

/** A cancelled duplicate whose cancellation date WAS filled in, as reported. */
const dupWithDate = {
  id: "dup-dated",
  columnKey: "cancelled",
  completedAt: "2026-11-02T00:00:00.000Z",
};

describe("the retrospective's live carry-forward list", () => {
  it("leaves out a cancelled duplicate and keeps the work still open", () => {
    const r = resolveCarriedItems({
      status: "ACTIVE",
      items: [
        { id: "shipped-1", columnKey: "shipped" },
        { id: "open-1", columnKey: "in_progress" },
        { id: "dup-1", columnKey: "cancelled" },
      ],
      report: null,
      statuses: STATUSES,
    });
    expect(r).toEqual({ kind: "live", itemIds: ["open-1"] });
  });

  it("needs no cancellation date to do it, and is not confused by one", () => {
    // The reporter set a completion date on every duplicate. Carry-forward goes
    // by STATUS alone: a cancelled item needs no more work whether or not
    // anyone recorded when it stopped, so the date neither adds nor removes it.
    const dated = resolveCarriedItems({
      status: "ACTIVE",
      items: [dupWithDate, { id: "open-1", columnKey: "todo" }],
      report: null,
      statuses: STATUSES,
    });
    const undated = resolveCarriedItems({
      status: "ACTIVE",
      items: [
        { id: "dup-dated", columnKey: "cancelled" },
        { id: "open-1", columnKey: "todo" },
      ],
      report: null,
      statuses: STATUSES,
    });
    expect(dated).toEqual({ kind: "live", itemIds: ["open-1"] });
    expect(undated).toEqual(dated);
  });

  it("still carries a 'cancelled' lane a team re-categorised to live work", () => {
    // The category is believed over the key, as everywhere else: this lane is
    // in use for real work, whatever it is called.
    const r = resolveCarriedItems({
      status: "ACTIVE",
      items: [{ id: "a", columnKey: "cancelled" }],
      report: null,
      statuses: [{ key: "cancelled", category: "IN_PROGRESS" }],
    });
    expect(r).toEqual({ kind: "live", itemIds: ["a"] });
  });
});

describe("the report recorded when the sprint completes", () => {
  const items = [
    { id: "shipped-1", columnKey: "shipped", storyPoints: 5, priority: "HIGH" },
    { id: "open-1", columnKey: "todo", storyPoints: 3, priority: "MEDIUM" },
    { id: "dup-1", columnKey: "cancelled", storyPoints: 8, priority: "HIGH" },
  ];
  const report = buildIntervalReport(items, "2026-11-13T12:00:00.000Z", STATUSES);

  it("names only the items that actually roll into the next sprint", () => {
    // This list IS the next sprint's inheritance, and the only surviving record
    // of it: completing the sprint severs the items' link to it.
    expect(report.carriedItemIds).toEqual(["open-1"]);
    expect(report.incompleteItems).toBe(1);
  });

  it("leaves the commitment alone — cancelled work still counts as committed", () => {
    // Deliberate, and the behaviour the report asked us to confirm: the team
    // committed to 16 points before the duplicates were found. Delivered is 5,
    // outstanding is 1 item, and the rest is visibly the gap.
    expect(report.totalItems).toBe(3);
    expect(report.totalStoryPoints).toBe(16);
    expect(report.completedItems).toBe(1);
    expect(report.velocity).toBe(5);
  });
});

describe("the ceremony summary's carried count", () => {
  const review = computeSprintReview({
    startDate: "2026-11-02T00:00:00.000Z",
    endDate: "2026-11-13T00:00:00.000Z",
    reviewedAt: "2026-11-13T00:00:00.000Z",
    items: [
      { storyPoints: 5, columnKey: "done" },
      { storyPoints: 3, columnKey: "in_progress" },
      { storyPoints: 8, columnKey: "cancelled" },
    ],
    columns: STATUSES,
  });

  it("counts what carries, not everything undelivered", () => {
    // Rendered as "N carried →" beside the completion bar, so a cancelled
    // duplicate counted here contradicts the Carrying-forward tab next to it.
    expect(review.incompleteItems).toBe(1);
  });

  it("keeps committed points and efficiency measured against the whole sprint", () => {
    expect(review.totalPoints).toBe(16);
    expect(review.completedPoints).toBe(5);
    // 5 of 16 committed points. Discounting the duplicates would flatter this.
    expect(review.efficiency).toBe(31);
    expect(review.pacingStatus).toBe("behind");
  });
});
