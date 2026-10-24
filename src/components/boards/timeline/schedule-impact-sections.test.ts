// Core's rows for the confirm step (schedule-impact-sections.ts).
import { describe, it, expect } from "vitest";
import { coreImpactSections, shiftText } from "./schedule-impact-sections";

// Local midnights: the chart's days, the same in any timezone.
const ld = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).toISOString();
};
const ch = (id: string, b: [string, string], a: [string, string]) => ({
  itemId: id,
  before: { startDate: ld(b[0]), dueDate: ld(b[1]) },
  after: { startDate: ld(a[0]), dueDate: ld(a[1]) },
});
const label = (id: string) => ({ a: "FSC-1, Design", b: "FSC-2, Build" })[id] ?? id;
const base = { changes: [ch("a", ["2026-11-02", "2026-11-06"], ["2026-11-05", "2026-11-09"])], cascaded: [], allocation: [], sections: [] };

describe("shiftText", () => {
  it("says how far it moved and how its length changed", () => {
    expect(shiftText(ch("a", ["2026-11-02", "2026-11-06"], ["2026-11-05", "2026-11-09"]))).toBe("3 days later");
    expect(shiftText(ch("a", ["2026-11-02", "2026-11-06"], ["2026-11-01", "2026-11-05"]))).toBe("1 day earlier");
    expect(shiftText(ch("a", ["2026-11-02", "2026-11-06"], ["2026-11-02", "2026-11-08"]))).toBe("2 days longer");
    expect(shiftText(ch("a", ["2026-11-02", "2026-11-06"], ["2026-11-04", "2026-11-06"]))).toBe("2 days later, 2 days shorter");
    expect(shiftText(ch("a", ["2026-11-02", "2026-11-06"], ["2026-11-02", "2026-11-06"]))).toBeUndefined();
  });
});

describe("coreImpactSections", () => {
  it("a plain move is one section: the change, with its dates and shift", () => {
    expect(coreImpactSections(base, label)).toEqual([
      {
        key: "schedule",
        title: "The change",
        rows: [{ key: "item:a", label: "FSC-1, Design", before: "2 Nov 2026 to 6 Nov 2026", after: "5 Nov 2026 to 9 Nov 2026", delta: "3 days later", tone: "neutral" }],
      },
    ]);
  });

  it("what the cascade moves is listed with why, as a warning", () => {
    const [, deps] = coreImpactSections(
      { ...base, cascaded: [{ ...ch("b", ["2026-11-09", "2026-11-13"], ["2026-11-12", "2026-11-16"]), reason: "successor-shift" }] },
      label,
    );
    expect(deps).toEqual({
      key: "dependencies",
      title: "Also moves",
      rows: [{ key: "item:b", label: "FSC-2, Build, waits on a moved item", before: "9 Nov 2026 to 13 Nov 2026", after: "12 Nov 2026 to 16 Nov 2026", delta: "3 days later", tone: "warn" }],
    });
  });

  it("people: more at once is a warning, less is better, and points are shown when they change", () => {
    const person = (peakBefore: number, peakAfter: number, pts = [5, 5], cap: number | null = 32) => ({
      userId: `u${peakBefore}${peakAfter}`, name: "Dana", weeklyCapacityHours: cap, peakBefore, peakAfter, pointsBefore: pts[0], pointsAfter: pts[1],
    });
    const [, people] = coreImpactSections({ ...base, allocation: [person(1, 2), person(2, 1, [5, 3], null), person(1, 1, [2, 4])] }, label);
    expect(people.rows).toEqual([
      { key: "person:u12", label: "Dana (32 h a week)", before: "1 at once", after: "2 at once", delta: undefined, tone: "warn" },
      { key: "person:u21", label: "Dana", before: "2 at once", after: "1 at once", delta: "5 → 3 points in this window", tone: "positive" },
      { key: "person:u11", label: "Dana (32 h a week)", before: "1 at once", after: "1 at once", delta: "2 → 4 points in this window", tone: "neutral" },
    ]);
  });

  it("plugin sections come after core's, untouched", () => {
    const plugin = { key: "fees:fee", title: "Fee", rows: [{ key: "rate", label: "Rate", tone: "positive" as const }] };
    const out = coreImpactSections({ ...base, sections: [plugin] }, label);
    expect(out.map((s) => s.key)).toEqual(["schedule", "fees:fee"]);
    expect(out[1]).toBe(plugin);
  });
});
