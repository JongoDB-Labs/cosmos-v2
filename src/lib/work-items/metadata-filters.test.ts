import { describe, it, expect } from "vitest";
import { matchesDuePreset, matchesOneOf, DUE_PRESETS } from "./metadata-filters";

const NOW = new Date("2026-08-01T12:00:00Z");
const at = (iso: string) => new Date(iso).toISOString();

describe("matchesDuePreset", () => {
  it("is inert on 'any'", () => {
    expect(matchesDuePreset(at("2020-01-01"), "any", NOW)).toBe(true);
    expect(matchesDuePreset(null, "any", NOW)).toBe(true);
  });

  it("finds what is late", () => {
    expect(matchesDuePreset(at("2026-07-31T12:00:00Z"), "overdue", NOW)).toBe(true);
    expect(matchesDuePreset(at("2026-08-02T12:00:00Z"), "overdue", NOW)).toBe(false);
  });

  it("treats an undated item as not overdue", () => {
    // Nothing was promised, so nothing is late. Sweeping undated work into
    // "overdue" is how a board turns into noise nobody trusts.
    expect(matchesDuePreset(null, "overdue", NOW)).toBe(false);
  });

  it("reads 'this week' as the next 7 days, not the calendar week", () => {
    // On a Friday, a calendar week leaves two days and hides most of what the
    // reader is looking for. A board is read as a rolling horizon.
    expect(matchesDuePreset(at("2026-08-06T12:00:00Z"), "week", NOW)).toBe(true);
    expect(matchesDuePreset(at("2026-08-09T12:00:00Z"), "week", NOW)).toBe(false);
  });

  it("excludes already-overdue work from 'this week'", () => {
    // "Due this week" is forward-looking; late work has its own lens.
    expect(matchesDuePreset(at("2026-07-30T12:00:00Z"), "week", NOW)).toBe(false);
  });

  it("covers 30 days for 'this month'", () => {
    expect(matchesDuePreset(at("2026-08-25T12:00:00Z"), "month", NOW)).toBe(true);
    expect(matchesDuePreset(at("2026-09-15T12:00:00Z"), "month", NOW)).toBe(false);
  });

  it("finds the undated with 'none', and only those", () => {
    expect(matchesDuePreset(null, "none", NOW)).toBe(true);
    expect(matchesDuePreset(undefined, "none", NOW)).toBe(true);
    expect(matchesDuePreset(at("2026-08-02T12:00:00Z"), "none", NOW)).toBe(false);
  });

  it("treats an unparseable date as undated rather than throwing", () => {
    expect(matchesDuePreset("not-a-date", "none", NOW)).toBe(true);
    expect(matchesDuePreset("not-a-date", "overdue", NOW)).toBe(false);
  });

  it("offers every preset the matcher understands", () => {
    // A menu entry with no matching branch silently filters nothing.
    for (const p of DUE_PRESETS) {
      expect(() => matchesDuePreset(at("2026-08-02"), p.value, NOW)).not.toThrow();
    }
  });
});

describe("matchesOneOf", () => {
  it("is inert when nothing is selected", () => {
    expect(matchesOneOf("todo", [])).toBe(true);
    expect(matchesOneOf(null, [])).toBe(true);
  });

  it("matches a selected value", () => {
    expect(matchesOneOf("todo", ["todo", "doing"])).toBe(true);
  });

  it("rejects an unselected one", () => {
    expect(matchesOneOf("done", ["todo"])).toBe(false);
  });

  it("excludes an item with no value once a selection exists", () => {
    expect(matchesOneOf(null, ["todo"])).toBe(false);
    expect(matchesOneOf(undefined, ["todo"])).toBe(false);
  });
});
