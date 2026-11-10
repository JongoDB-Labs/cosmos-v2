// @vitest-environment node
import { describe, it, expect } from "vitest";
import { packWeek, weekDays, weeksIn } from "./layout";
import { DAY_MS } from "./time";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
// Sunday 8 Nov 2026.
const WEEK = utc(2026, 11, 8);
const ev = (id: string, startDay: number, days: number) => ({
  id,
  startsAt: new Date(WEEK.getTime() + startDay * DAY_MS),
  endsAt: new Date(WEEK.getTime() + (startDay + days) * DAY_MS),
});

describe("a multi-day event is one bar, not one chip per day", () => {
  it("spans the columns it covers", () => {
    const { placed } = packWeek([ev("a", 1, 3)], WEEK);
    expect(placed).toHaveLength(1);
    expect(placed[0].startCol).toBe(2); // Monday, 1-based
    expect(placed[0].span).toBe(3);
  });

  it("clips to the week and flags that it continues", () => {
    // Starts the previous Friday, ends the following Tuesday.
    const long = {
      id: "long",
      startsAt: new Date(WEEK.getTime() - 2 * DAY_MS),
      endsAt: new Date(WEEK.getTime() + 9 * DAY_MS),
    };
    const { placed } = packWeek([long], WEEK);
    expect(placed[0].startCol).toBe(1);
    expect(placed[0].span).toBe(7);
    expect(placed[0].continuesBefore).toBe(true);
    expect(placed[0].continuesAfter).toBe(true);
  });

  it("gives a single day a span of one", () => {
    const { placed } = packWeek([ev("a", 3, 1)], WEEK);
    expect(placed[0].span).toBe(1);
    expect(placed[0].startCol).toBe(4);
  });

  it("leaves out an event in a different week", () => {
    const { placed, overflow } = packWeek([ev("a", 9, 1)], WEEK);
    expect(placed).toHaveLength(0);
    expect(overflow.every((n) => n === 0)).toBe(true);
  });
});

describe("lanes keep overlapping events apart", () => {
  it("puts two events that share a day on different lanes", () => {
    const { placed } = packWeek([ev("a", 1, 2), ev("b", 2, 2)], WEEK);
    const lanes = placed.map((p) => p.lane).sort();
    expect(lanes).toEqual([0, 1]);
  });

  it("reuses a lane for events that do NOT overlap", () => {
    // Without this the packer could simply give everything its own lane and
    // the overlap assertions above would still pass.
    const { placed, laneCount } = packWeek([ev("a", 0, 2), ev("b", 3, 2)], WEEK);
    expect(placed.every((p) => p.lane === 0)).toBe(true);
    expect(laneCount).toBe(1);
  });

  it("packs the longest bar first so it is not pushed down by a shorter one", () => {
    // The short event must start STRICTLY EARLIER and still overlap, or the
    // two tie on start and the id tiebreak decides — which is how the first
    // version of this test passed against start-order packing and proved
    // nothing. "short" covers Sun-Mon, "long" covers Mon-Fri; under start
    // order the short one takes lane 0 and pushes the long bar down.
    const { placed } = packWeek([ev("short", 0, 2), ev("long", 1, 5)], WEEK);
    const long = placed.find((p) => p.event.id === "long")!;
    const short = placed.find((p) => p.event.id === "short")!;
    expect(long.lane).toBe(0);
    expect(short.lane).toBe(1);
  });

  it("is stable: the same input gives the same lanes", () => {
    const input = [ev("b", 1, 2), ev("a", 1, 2), ev("c", 1, 2)];
    const first = packWeek(input, WEEK).placed.map((p) => `${p.event.id}:${p.lane}`);
    const second = packWeek([...input].reverse(), WEEK).placed.map((p) => `${p.event.id}:${p.lane}`);
    expect(new Set(first)).toEqual(new Set(second));
  });
});

describe("overflow counts what did not fit", () => {
  it("pushes beyond the lane cap into per-day counts", () => {
    const events = [ev("a", 2, 1), ev("b", 2, 1), ev("c", 2, 1), ev("d", 2, 1), ev("e", 2, 1)];
    const { placed, overflow } = packWeek(events, WEEK, 3);
    expect(placed).toHaveLength(3);
    expect(overflow[2]).toBe(2);
    expect(overflow.filter((_, i) => i !== 2).every((n) => n === 0)).toBe(true);
  });

  it("counts a hidden multi-day event on every day it covers", () => {
    const events = [
      ev("a", 0, 7), ev("b", 0, 7), ev("c", 0, 7),
      ev("hidden", 1, 3),
    ];
    const { overflow } = packWeek(events, WEEK, 3);
    expect(overflow[1]).toBe(1);
    expect(overflow[2]).toBe(1);
    expect(overflow[3]).toBe(1);
    expect(overflow[0]).toBe(0);
    expect(overflow[4]).toBe(0);
  });
});

describe("week helpers", () => {
  it("gives seven consecutive UTC midnights", () => {
    const days = weekDays(WEEK);
    expect(days).toHaveLength(7);
    expect(days[0].toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(days[6].toISOString()).toBe("2026-11-14T00:00:00.000Z");
  });

  it("splits a month window into whole weeks", () => {
    const weeks = weeksIn(utc(2026, 11, 1), utc(2026, 12, 6));
    expect(weeks).toHaveLength(5);
    expect(weeks[0].toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});
