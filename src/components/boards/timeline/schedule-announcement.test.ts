// The sentences the Gantt's live region reads out (see schedule-announcement.ts).
import { describe, it, expect } from "vitest";
import { announceSchedule } from "./schedule-announcement";

const label = (id: string) => ({ a: "FSC-1, Design", b: "FSC-2", c: "FSC-3" })[id] ?? "?";
// Local midnight, which is how the timeline stores a dragged day.
const local = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toISOString();
};
const r = (s: string | null, e: string | null) => ({
  startDate: s && local(s),
  dueDate: e && local(e),
});
const edit = (n: number) => ({
  items: [
    { id: "a", before: r("2026-03-01", "2026-03-05"), after: r("2026-03-03", "2026-03-07") },
    ...Array.from({ length: n }, (_, i) => ({ id: i ? "c" : "b", before: r(null, null), after: r(null, null) })),
  ],
});

describe("announceSchedule", () => {
  it("a move names the item, its new range and how to undo", () => {
    expect(announceSchedule("moved", edit(0), label)).toBe(
      "Moved FSC-1, Design to 3 Mar 2026 to 7 Mar 2026. Press Control Z or Command Z to undo.",
    );
  });

  it("counts the other items that moved with it, singular and plural", () => {
    expect(announceSchedule("moved", edit(1), label)).toContain(" 1 other item moved with it.");
    expect(announceSchedule("moved", edit(2), label)).toContain(" 2 other items moved with it.");
  });

  it("undo reads the dates it went back to; redo the dates it went forward to", () => {
    expect(announceSchedule("undo", edit(2), label)).toBe(
      "Undid the change to FSC-1, Design: back to 1 Mar 2026 to 5 Mar 2026. 2 other items moved back.",
    );
    expect(announceSchedule("redo", edit(0), label)).toBe("Redid the change to FSC-1, Design: 3 Mar 2026 to 7 Mar 2026.");
  });

  it("a one-day bar, a due date alone, a start alone, and no dates", () => {
    const one = (after: ReturnType<typeof r>) => ({ items: [{ id: "a", before: r(null, null), after }] });
    expect(announceSchedule("redo", one(r("2026-03-04", "2026-03-04")), label)).toBe("Redid the change to FSC-1, Design: 4 Mar 2026.");
    expect(announceSchedule("redo", one(r(null, "2026-03-04")), label)).toContain(": due 4 Mar 2026.");
    expect(announceSchedule("redo", one(r("2026-03-04", null)), label)).toContain(": starting 4 Mar 2026.");
    expect(announceSchedule("redo", one(r(null, null)), label)).toContain(": no dates.");
  });

  it("reads the viewer's local calendar day, the day the bar is drawn on", () => {
    // Midnight UTC is still the evening before in the Americas, and the chart
    // (startOfDay, toLocaleDateString) draws that bar on the evening's day.
    const utcMidnight = "2026-03-01T00:00:00.000Z";
    const drawnOn = new Date(utcMidnight);
    const expected = `${drawnOn.getDate()} ${drawnOn.toLocaleString("en-GB", { month: "short" })} ${drawnOn.getFullYear()}`;
    const text = announceSchedule("redo", { items: [{ id: "a", before: r(null, null), after: { startDate: utcMidnight, dueDate: null } }] }, label);
    expect(text).toContain(`starting ${expected}.`);
  });

  it("an empty edit says nothing", () => {
    expect(announceSchedule("undo", { items: [] }, label)).toBe("");
  });
});
