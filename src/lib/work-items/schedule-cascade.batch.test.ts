/**
 * `skipIds`: the items a cascade must treat as already settled (COSMOS-154
 * follow-up).
 *
 * One user action can rewrite several items — a multi-select Shift on the Gantt,
 * an undo restoring a whole cascade — and each one travels as its own request.
 * Every request cascades a RELATIVE shift and cannot see the others, so without
 * this the members walk over each other: select both ends of `A → B → C`, shift
 * by five days, and C gets ten because A's cascade pushes it and B's pushes it
 * again.
 *
 * Two distinct guarantees are tested here, and they fail differently:
 *   - a skipped item is never MOVED (it has its own request setting its dates);
 *   - a skipped item is never PROPAGATED THROUGH (its own request will cascade
 *     onward from its own new dates, so reaching past it duplicates that work).
 * A `skip` that only prevented the write would leave the second one broken, and
 * the chain case is exactly how that shows up.
 */
import { describe, it, expect } from "vitest";
import {
  planScheduleCascade,
  type CascadeItem,
  type CascadeLink,
} from "@/lib/work-items/schedule-cascade";

const DAY = 86_400_000;
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (v: Date | null) => (v ? v.toISOString().slice(0, 10) : null);

function item(
  id: string,
  start: string | null,
  due: string | null,
  parentId: string | null = null,
): CascadeItem {
  return {
    id,
    parentId,
    startDate: start ? d(start) : null,
    dueDate: due ? d(due) : null,
  };
}

const link = (type: string, sourceItemId: string, targetItemId: string): CascadeLink => ({
  type,
  sourceItemId,
  targetItemId,
});

function asSchedule(updates: ReturnType<typeof planScheduleCascade>) {
  return Object.fromEntries(updates.map((u) => [u.id, [iso(u.startDate), iso(u.dueDate)]]));
}

// A → B → C, every hand-off tight.
const CHAIN = [
  item("a", "2026-01-01", "2026-01-05"),
  item("b", "2026-01-06", "2026-01-10"),
  item("c", "2026-01-11", "2026-01-15"),
];
const CHAIN_LINKS = [link("PREDECESSOR", "a", "b"), link("BLOCKS", "b", "c")];

describe("planScheduleCascade — items the same action is writing by hand", () => {
  it("moves the whole chain when nothing is skipped (the premise)", () => {
    // Guard: every assertion below is about something NOT happening, so this
    // control has to prove the fixture cascades at all.
    expect(asSchedule(planScheduleCascade(CHAIN, CHAIN_LINKS, { id: "a", dueShiftMs: 2 * DAY })))
      .toEqual({
        b: ["2026-01-08", "2026-01-12"],
        c: ["2026-01-13", "2026-01-17"],
      });
  });

  it("does not move a successor the caller is writing itself", () => {
    const updates = planScheduleCascade(CHAIN, CHAIN_LINKS, {
      id: "a",
      dueShiftMs: 2 * DAY,
      skipIds: ["b"],
    });
    expect(updates.map((u) => u.id)).not.toContain("b");
  });

  it("does not reach PAST it either — that item's own request carries the chain", () => {
    // The whole double-shift bug in one assertion. `b` is being shifted by its
    // own request, and that request will push `c`. If this cascade pushed `c`
    // too, `c` would end up two days further out than anyone asked for.
    expect(
      planScheduleCascade(CHAIN, CHAIN_LINKS, { id: "a", dueShiftMs: 2 * DAY, skipIds: ["b"] }),
    ).toEqual([]);
  });

  it("still cascades to everything NOT in the skip list", () => {
    // Only `c` is claimed by another request; `b` is fair game and its own slip
    // must not then run on to `c`.
    expect(
      asSchedule(
        planScheduleCascade(CHAIN, CHAIN_LINKS, { id: "a", dueShiftMs: 2 * DAY, skipIds: ["c"] }),
      ),
    ).toEqual({ b: ["2026-01-08", "2026-01-12"] });
  });

  it("handles a dependent shared by two skipped predecessors", () => {
    // A → C and B → C, with A and B both selected. Whichever request runs
    // second names C in its skip list (the first one's cascade already moved
    // it), and must then leave it alone.
    const items = [
      item("a", "2026-01-01", "2026-01-05"),
      item("b", "2026-01-01", "2026-01-05"),
      item("c", "2026-01-06", "2026-01-10"),
    ];
    const links = [link("PREDECESSOR", "a", "c"), link("PREDECESSOR", "b", "c")];
    expect(
      planScheduleCascade(items, links, { id: "b", dueShiftMs: 2 * DAY, skipIds: ["a", "c"] }),
    ).toEqual([]);
  });

  it("does not re-widen a parent the caller is restoring", () => {
    // An undo puts the story AND the epic its slip had stretched back at once.
    // Recomputing the epic's envelope from the restored story is harmless, but
    // recomputing it while the story is still slipped would undo the undo.
    const items = [
      item("epic", "2026-01-01", "2026-01-31"),
      item("story", "2026-01-10", "2026-02-20", "epic"),
    ];
    expect(
      planScheduleCascade(items, [], { id: "story", dueShiftMs: 20 * DAY, skipIds: ["epic"] }),
    ).toEqual([]);
    // Control: without the skip the epic DOES stretch, so the fixture is real.
    expect(planScheduleCascade(items, [], { id: "story", dueShiftMs: 20 * DAY })).toHaveLength(1);
  });

  it("does not climb past a skipped parent to its grandparent", () => {
    const items = [
      item("epic", "2026-01-01", "2026-01-31"),
      item("feature", "2026-01-05", "2026-01-25", "epic"),
      item("task", "2026-01-10", "2026-02-20", "feature"),
    ];
    expect(
      planScheduleCascade(items, [], { id: "task", dueShiftMs: 26 * DAY, skipIds: ["feature"] }),
    ).toEqual([]);
  });

  it("ignores a skip list naming the origin or an unknown id", () => {
    expect(
      asSchedule(
        planScheduleCascade(CHAIN, CHAIN_LINKS, {
          id: "a",
          dueShiftMs: 2 * DAY,
          skipIds: ["a", "ghost"],
        }),
      ),
    ).toEqual({
      b: ["2026-01-08", "2026-01-12"],
      c: ["2026-01-13", "2026-01-17"],
    });
  });

  it("is unchanged by an empty or absent skip list", () => {
    const withEmpty = planScheduleCascade(CHAIN, CHAIN_LINKS, {
      id: "a",
      dueShiftMs: 2 * DAY,
      skipIds: [],
    });
    expect(asSchedule(withEmpty)).toEqual(
      asSchedule(planScheduleCascade(CHAIN, CHAIN_LINKS, { id: "a", dueShiftMs: 2 * DAY })),
    );
  });
});
