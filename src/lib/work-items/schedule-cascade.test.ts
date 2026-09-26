import { describe, it, expect } from "vitest";
import {
  planScheduleCascade,
  scheduleViolations,
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

/** The plan as `{id: [start, due]}`, so assertions read like a schedule. */
function asSchedule(updates: ReturnType<typeof planScheduleCascade>) {
  return Object.fromEntries(updates.map((u) => [u.id, [iso(u.startDate), iso(u.dueDate)]]));
}

describe("planScheduleCascade — downstream successors", () => {
  it("shifts a PREDECESSOR's successor by the same slip, preserving its duration", () => {
    // task slipped 3 days (its due moved 2026-01-10 -> 2026-01-13).
    const items = [item("task", "2026-01-05", "2026-01-13"), item("next", "2026-01-11", "2026-01-20")];
    const links = [link("PREDECESSOR", "task", "next")];

    const updates = planScheduleCascade(items, links, { id: "task", dueShiftMs: 3 * DAY });

    expect(asSchedule(updates)).toEqual({ next: ["2026-01-14", "2026-01-23"] });
    expect(updates[0].reason).toBe("successor-shift");
  });

  it("propagates recursively down a chain", () => {
    const items = [
      item("a", "2026-01-01", "2026-01-05"),
      item("b", "2026-01-06", "2026-01-10"),
      item("c", "2026-01-11", "2026-01-15"),
    ];
    const links = [link("PREDECESSOR", "a", "b"), link("BLOCKS", "b", "c")];

    const updates = planScheduleCascade(items, links, { id: "a", dueShiftMs: 2 * DAY });

    expect(asSchedule(updates)).toEqual({
      b: ["2026-01-08", "2026-01-12"],
      c: ["2026-01-13", "2026-01-17"],
    });
  });

  it("reads BLOCKED_BY / SUCCESSOR in the reverse direction, like the dependency map", () => {
    // "next BLOCKED_BY task" means task must come first — so a slip on `task`
    // moves `next`, not the other way round.
    const items = [item("task", "2026-01-05", "2026-01-13"), item("next", "2026-01-11", "2026-01-20")];

    expect(
      asSchedule(
        planScheduleCascade(items, [link("BLOCKED_BY", "next", "task")], {
          id: "task",
          dueShiftMs: 3 * DAY,
        }),
      ),
    ).toEqual({ next: ["2026-01-14", "2026-01-23"] });

    // …and nothing moves when the SAME link is walked from the downstream end.
    expect(
      planScheduleCascade(items, [link("BLOCKED_BY", "next", "task")], {
        id: "next",
        dueShiftMs: 3 * DAY,
      }),
    ).toEqual([]);
  });

  it("leaves soft RELATES / DUPLICATES links alone — they impose no ordering", () => {
    const items = [item("a", "2026-01-01", "2026-01-05"), item("b", "2026-01-06", "2026-01-10")];
    expect(planScheduleCascade(items, [link("RELATES", "a", "b")], { id: "a", dueShiftMs: DAY })).toEqual([]);
  });

  it("does NOT drag dependents earlier when an item is pulled IN", () => {
    const items = [item("a", "2026-01-01", "2026-01-05"), item("b", "2026-01-06", "2026-01-10")];
    expect(
      planScheduleCascade(items, [link("PREDECESSOR", "a", "b")], { id: "a", dueShiftMs: -3 * DAY }),
    ).toEqual([]);
  });

  it("never rewrites the item the user just saved", () => {
    const items = [item("a", "2026-01-01", "2026-01-05"), item("b", "2026-01-06", "2026-01-10")];
    // A cycle: a → b → a. Both edges exist, so a naive walk would come back
    // round and move `a` itself.
    const links = [link("PREDECESSOR", "a", "b"), link("PREDECESSOR", "b", "a")];

    const updates = planScheduleCascade(items, links, { id: "a", dueShiftMs: DAY });

    expect(updates.map((u) => u.id)).toEqual(["b"]);
  });

  it("skips an unscheduled successor rather than inventing dates for it", () => {
    const items = [item("a", "2026-01-01", "2026-01-05"), item("b", null, null)];
    expect(planScheduleCascade(items, [link("PREDECESSOR", "a", "b")], { id: "a", dueShiftMs: DAY })).toEqual([]);
  });
});

describe("planScheduleCascade — parent envelope", () => {
  it("expands the parent epic to cover a child that slipped past it", () => {
    const items = [
      item("epic", "2026-01-01", "2026-01-31"),
      item("story", "2026-01-10", "2026-02-10", "epic"),
    ];

    const updates = planScheduleCascade(items, [], { id: "story", dueShiftMs: 10 * DAY });

    expect(asSchedule(updates)).toEqual({ epic: ["2026-01-01", "2026-02-10"] });
    expect(updates[0].reason).toBe("parent-envelope");
  });

  it("pulls the parent's start back for a child that begins before it", () => {
    const items = [
      item("epic", "2026-02-01", "2026-03-01"),
      item("story", "2026-01-20", "2026-02-15", "epic"),
    ];
    expect(asSchedule(planScheduleCascade(items, [], { id: "story", dueShiftMs: 0 }))).toEqual({
      epic: ["2026-01-20", "2026-03-01"],
    });
  });

  it("never shrinks a parent scheduled deliberately wider than its children", () => {
    const items = [
      item("epic", "2026-01-01", "2026-12-31"),
      item("story", "2026-03-01", "2026-03-10", "epic"),
    ];
    expect(planScheduleCascade(items, [], { id: "story", dueShiftMs: 2 * DAY })).toEqual([]);
  });

  it("climbs the whole ancestor chain — task to feature to epic", () => {
    const items = [
      item("epic", "2026-01-01", "2026-01-31"),
      item("feature", "2026-01-05", "2026-01-25", "epic"),
      item("task", "2026-01-10", "2026-02-20", "feature"),
    ];

    expect(asSchedule(planScheduleCascade(items, [], { id: "task", dueShiftMs: 26 * DAY }))).toEqual({
      feature: ["2026-01-05", "2026-02-20"],
      epic: ["2026-01-01", "2026-02-20"],
    });
  });

  it("takes an expanded parent's OWN successors downstream with it", () => {
    // The task slips 5 days; that pushes its epic's finish out 5 days; the epic
    // has a successor of its own, which must move too.
    const items = [
      item("epic", "2026-01-01", "2026-01-31"),
      item("task", "2026-01-10", "2026-02-05", "epic"),
      item("nextEpic", "2026-02-01", "2026-03-01"),
    ];
    const links = [link("PREDECESSOR", "epic", "nextEpic")];

    expect(asSchedule(planScheduleCascade(items, links, { id: "task", dueShiftMs: 5 * DAY }))).toEqual({
      epic: ["2026-01-01", "2026-02-05"],
      nextEpic: ["2026-02-06", "2026-03-06"],
    });
  });

  it("expands a parent for a sibling that a downstream shift pushed out", () => {
    // `first` slips 4 days, shifting its sibling `second`; the epic covering
    // both has to stretch to the sibling's NEW finish.
    const items = [
      item("epic", "2026-01-01", "2026-01-20"),
      item("first", "2026-01-01", "2026-01-09", "epic"),
      item("second", "2026-01-10", "2026-01-20", "epic"),
    ];
    const links = [link("PREDECESSOR", "first", "second")];

    expect(asSchedule(planScheduleCascade(items, links, { id: "first", dueShiftMs: 4 * DAY }))).toEqual({
      second: ["2026-01-14", "2026-01-24"],
      epic: ["2026-01-01", "2026-01-24"],
    });
  });

  it("returns nothing when the saved item is not in the set", () => {
    expect(planScheduleCascade([item("a", "2026-01-01", "2026-01-05")], [], { id: "ghost", dueShiftMs: DAY })).toEqual([]);
  });
});

describe("scheduleViolations", () => {
  const violating = [
    { id: "a", startDate: d("2026-01-01"), dueDate: d("2026-01-15") },
    { id: "b", startDate: d("2026-01-10"), dueDate: d("2026-01-20") },
  ];

  it("flags a predecessor that finishes after its successor starts", () => {
    expect(scheduleViolations(violating, [link("PREDECESSOR", "a", "b")])).toEqual([
      { fromId: "a", toId: "b", overlapDays: 5 },
    ]);
  });

  it("allows a predecessor finishing exactly ON the successor's start", () => {
    const ok = [
      { id: "a", startDate: d("2026-01-01"), dueDate: d("2026-01-10") },
      { id: "b", startDate: d("2026-01-10"), dueDate: d("2026-01-20") },
    ];
    expect(scheduleViolations(ok, [link("PREDECESSOR", "a", "b")])).toEqual([]);
  });

  it("ignores soft links and unscheduled ends", () => {
    expect(scheduleViolations(violating, [link("RELATES", "a", "b")])).toEqual([]);
    expect(
      scheduleViolations([{ id: "a", startDate: null, dueDate: null }, violating[1]], [
        link("PREDECESSOR", "a", "b"),
      ]),
    ).toEqual([]);
  });

  it("reports one violation per direction, not per duplicate link", () => {
    // The same constraint expressed twice (BLOCKS one way, BLOCKED_BY the
    // other) is one problem on the chart, not two.
    const links = [link("BLOCKS", "a", "b"), link("BLOCKED_BY", "b", "a")];
    expect(scheduleViolations(violating, links)).toHaveLength(1);
  });
});
