import { describe, it, expect } from "vitest";
import { columnAt, cumulativeFlow, type CfdItem } from "./cfd";

const cat = (k: string) => (k === "done" ? "DONE" : k === "doing" ? "IN_PROGRESS" : "TODO") as "DONE" | "IN_PROGRESS" | "TODO";
const END = new Date("2026-10-10T12:00:00Z");

describe("cumulative flow", () => {
  it("reconstructs each day's column from recorded changes", () => {
    const item: CfdItem = {
      createdAt: "2026-10-01T09:00:00Z",
      completedAt: "2026-10-08T09:00:00Z",
      columnKey: "done",
      transitions: [
        { at: "2026-10-08T09:00:00Z", from: "doing", to: "done" },
        { at: "2026-10-05T09:00:00Z", from: "todo", to: "doing" },
      ],
    };
    expect(columnAt(item, Date.parse("2026-10-03T23:00:00Z"))).toBe("todo");
    expect(columnAt(item, Date.parse("2026-10-06T23:00:00Z"))).toBe("doing");
    expect(columnAt(item, Date.parse("2026-10-09T23:00:00Z"))).toBe("done");
    const flow = cumulativeFlow({ items: [item], category: cat, end: END, days: 9 });
    expect(flow.exact).toBe(true);
    const byDate = Object.fromEntries(flow.points.map((p) => [p.date, p.counts]));
    expect(byDate["2026-10-01"]).toEqual({ TODO: 1 });
    expect(byDate["2026-10-06"]).toEqual({ IN_PROGRESS: 1 });
    expect(byDate["2026-10-10"]).toEqual({ DONE: 1 });
    expect(flow.categories).toEqual(["TODO", "IN_PROGRESS", "DONE"]);
  });

  it("without history: done once completed, a currently-done item in progress before that, nothing before creation", () => {
    const flow = cumulativeFlow({
      items: [{ createdAt: "2026-10-05T09:00:00Z", completedAt: "2026-10-08T09:00:00Z", columnKey: "done" }],
      category: cat,
      end: END,
      days: 9,
    });
    expect(flow.exact).toBe(false);
    const byDate = Object.fromEntries(flow.points.map((p) => [p.date, p.counts]));
    expect(byDate["2026-10-04"]).toEqual({});
    expect(byDate["2026-10-06"]).toEqual({ IN_PROGRESS: 1 });
    expect(byDate["2026-10-09"]).toEqual({ DONE: 1 });
  });
});
