import { describe, it, expect } from "vitest";
import { resolveCarriedItems } from "./ceremony-carried";

/**
 * "What we're carrying forward" has three honest answers, and conflating any
 * two of them misleads a room full of people:
 *
 *   live       — the sprint is still open, so derive it now
 *   recorded   — the sprint closed and the report named what moved
 *   unrecorded — the sprint closed BEFORE we started recording, so the set is
 *                genuinely unrecoverable
 *
 * The trap is reporting `unrecorded` as an empty list, which reads as "nothing
 * carried" — a claim the data cannot support.
 */

const items = [
  { id: "a", columnKey: "done" },
  { id: "b", columnKey: "in_review" },
  { id: "c", columnKey: "todo" },
];

describe("resolveCarriedItems", () => {
  it("derives from the board while the sprint is still open", () => {
    const r = resolveCarriedItems({ status: "ACTIVE", items, report: null });
    expect(r).toEqual({ kind: "live", itemIds: ["b", "c"] });
  });

  it("derives live for a sprint that has not started either", () => {
    const r = resolveCarriedItems({ status: "PLANNED", items, report: null });
    expect(r.kind).toBe("live");
  });

  it("reads the recorded set once the sprint has completed", () => {
    // The items themselves have moved on by now, so the report is the only
    // surviving witness — deriving from `items` here would return nothing.
    const r = resolveCarriedItems({
      status: "COMPLETED",
      items: [{ id: "a", columnKey: "done" }],
      report: { carriedItemIds: ["b", "c"] },
    });
    expect(r).toEqual({ kind: "recorded", itemIds: ["b", "c"] });
  });

  it("distinguishes a sprint that carried nothing from one we never recorded", () => {
    const carriedNothing = resolveCarriedItems({
      status: "COMPLETED",
      items: [],
      report: { carriedItemIds: [] },
    });
    expect(carriedNothing).toEqual({ kind: "recorded", itemIds: [] });

    // Completed before buildIntervalReport recorded IDs: absent, not empty.
    const neverRecorded = resolveCarriedItems({
      status: "COMPLETED",
      items: [],
      report: { totalItems: 25, completedItems: 19 },
    });
    expect(neverRecorded).toEqual({ kind: "unrecorded" });
  });

  it("treats a completed sprint with no report at all as unrecorded", () => {
    const r = resolveCarriedItems({ status: "COMPLETED", items: [], report: null });
    expect(r).toEqual({ kind: "unrecorded" });
  });

  it("ignores a malformed carriedItemIds rather than trusting it", () => {
    // The column is JSON, so nothing at the database level guarantees a shape.
    const r = resolveCarriedItems({
      status: "COMPLETED",
      items: [],
      report: { carriedItemIds: "b,c" },
    });
    expect(r).toEqual({ kind: "unrecorded" });
  });
});
