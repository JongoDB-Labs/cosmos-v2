// The pure parts of the time and chart widgets.
import { describe, expect, it } from "vitest";
import { cumulativeFlow } from "./chart-widgets";
import { dueLabel, packLanes } from "./time-widgets";
import { addDays, dayKey, daysBetween, localDayKey } from "./widget-parts";
import type { WidgetItemRow } from "@/lib/boards/widget-data";

const row = (over: Partial<WidgetItemRow>): WidgetItemRow => ({
  id: "x",
  key: "X-1",
  title: "x",
  status: "To Do",
  statusCategory: "TODO",
  priority: "Medium",
  assignee: "Unassigned",
  dueDate: null,
  startDate: null,
  createdAt: "2026-01-01T12:00:00.000Z",
  updatedAt: "2026-01-01T12:00:00.000Z",
  completedAt: null,
  typeKey: null,
  typeName: null,
  customFields: {},
  ...over,
});

describe("day keys", () => {
  it("reads a stored calendar date as its own day, whatever the reader's zone", () => {
    // Stored at midnight UTC: formatting it in a zone west of UTC would show
    // the day before.
    expect(dayKey("2026-11-12T00:00:00.000Z")).toBe("2026-11-12");
  });

  it("counts days and steps across a month end", () => {
    expect(daysBetween("2026-11-28", "2026-12-02")).toBe(4);
    expect(daysBetween("2026-12-02", "2026-11-28")).toBe(-4);
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("dueLabel", () => {
  it("says overdue, today, tomorrow or how long", () => {
    expect(dueLabel("2026-11-10", "2026-11-12")).toBe("2d overdue");
    expect(dueLabel("2026-11-12", "2026-11-12")).toBe("Today");
    expect(dueLabel("2026-11-13", "2026-11-12")).toBe("Tomorrow");
    expect(dueLabel("2026-11-20", "2026-11-12")).toBe("in 8d");
  });
});

describe("packLanes", () => {
  it("puts crowded markers in separate lanes and counts what does not fit", () => {
    const { placed, overflow } = packLanes(
      [{ at: 10 }, { at: 12 }, { at: 14 }, { at: 40 }],
      10,
      2,
    );
    expect(placed.map((p) => [p.at, p.lane])).toEqual([
      [10, 0],
      [12, 1],
      [40, 0],
    ]);
    expect(overflow).toBe(1);
  });
});

describe("cumulativeFlow", () => {
  it("counts work created and completed up to each day", () => {
    const now = new Date();
    const today = localDayKey(now);
    const at = (offset: number) => {
      // Midday local time on that day, so the local day key is unambiguous.
      const [y, m, d] = addDays(today, offset).split("-").map(Number);
      return new Date(y, m - 1, d, 12).toISOString();
    };
    const points = cumulativeFlow(
      [
        row({ id: "a", createdAt: at(-40) }),
        row({ id: "b", createdAt: at(-5), statusCategory: "DONE", completedAt: at(-2) }),
        // Completed once, then reopened: no longer done, so not counted.
        row({ id: "c", createdAt: at(-3), statusCategory: "TODO", completedAt: at(-1) }),
      ],
      7,
      now,
    );
    expect(points).toHaveLength(7);
    expect(points[0].day).toBe(addDays(today, -6));
    expect(points.at(-1)!.day).toBe(today);
    // Six days ago only `a` existed; by today all three do.
    expect(points[0]).toMatchObject({ created: 1, completed: 0 });
    expect(points.find((p) => p.day === addDays(today, -3))).toMatchObject({ created: 3, completed: 0 });
    expect(points.at(-1)).toMatchObject({ created: 3, completed: 1 });
  });
});
