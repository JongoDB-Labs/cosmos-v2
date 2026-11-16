// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  normalizeRange,
  allDayParts,
  overlaps,
  monthGridWindow,
  weekWindow,
  dayWindow,
  rollingWindow,
  DAY_MS,
  storedZoneName,
  isIanaZone,
  zoneOffsetMs,
  zoneCacheSizes,
} from "./time";

const utc = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, min));

describe("an all-day event is on its dates in every time zone", () => {
  it("keeps a one-day event on exactly its own day", () => {
    const r = normalizeRange({ startsAt: utc(2026, 11, 30), endsAt: utc(2026, 11, 30), allDay: true });
    expect(allDayParts(r.startsAt, r.endsAt)).toEqual([{ y: 2026, m: 10, d: 30 }]);
  });

  it("treats the end date as inclusive, as the form presents it", () => {
    // A multi-day event entered as "30 Nov - 4 Dec" is five days, not four.
    const r = normalizeRange({ startsAt: utc(2026, 11, 30), endsAt: utc(2026, 12, 4), allDay: true });
    expect(allDayParts(r.startsAt, r.endsAt)).toHaveLength(5);
    expect(r.endsAt.toISOString()).toBe("2026-12-05T00:00:00.000Z");
  });

  it("reads the date from the UTC fields, so it cannot slide west", () => {
    // The bug this guards: UTC midnight read through a zone west of UTC is the
    // PREVIOUS day, so a US reader sees a 30 Nov event start on 29 Nov. The
    // local-time reading is asserted here as the WRONG answer, so this fails
    // the moment someone swaps getUTCDate() for getDate().
    const r = normalizeRange({ startsAt: utc(2026, 11, 30), endsAt: utc(2026, 11, 30), allDay: true });
    const parts = allDayParts(r.startsAt, r.endsAt);
    expect(parts[0].d).toBe(30);
    const localReading = r.startsAt.getDate();
    if (r.startsAt.getTimezoneOffset() > 0) {
      // Only meaningful when the test machine is west of UTC; where it is, the
      // naive reading really does differ, which is the whole point.
      expect(parts[0].d).not.toBe(localReading);
    }
  });

  it("snaps a time-of-day to midnight when all-day is turned on", () => {
    const r = normalizeRange({ startsAt: utc(2026, 11, 30, 14, 30), endsAt: utc(2026, 11, 30, 16, 0), allDay: true });
    expect(r.startsAt.toISOString()).toBe("2026-11-30T00:00:00.000Z");
    expect(r.endsAt.getTime() - r.startsAt.getTime()).toBe(DAY_MS);
  });
});

describe("a timed event keeps its instants", () => {
  it("leaves a normal range untouched", () => {
    const r = normalizeRange({ startsAt: utc(2026, 11, 12, 15, 30), endsAt: utc(2026, 11, 12, 16, 30), allDay: false });
    expect(r.startsAt.toISOString()).toBe("2026-11-12T15:30:00.000Z");
    expect(r.endsAt.toISOString()).toBe("2026-11-12T16:30:00.000Z");
  });

  it("refuses to store an inverted range", () => {
    const r = normalizeRange({ startsAt: utc(2026, 11, 12, 16, 0), endsAt: utc(2026, 11, 12, 9, 0), allDay: false });
    expect(r.endsAt.getTime()).toBeGreaterThanOrEqual(r.startsAt.getTime());
  });
});

describe("overlap is half-open at both ends", () => {
  const ev = { startsAt: utc(2026, 11, 10), endsAt: utc(2026, 11, 11) };

  it("includes an event inside the window", () => {
    expect(overlaps(ev, utc(2026, 11, 1), utc(2026, 12, 1))).toBe(true);
  });

  it("excludes an event that ends exactly as the window opens", () => {
    expect(overlaps(ev, utc(2026, 11, 11), utc(2026, 11, 12))).toBe(false);
  });

  it("excludes an event that starts exactly as the window closes", () => {
    // Without this an event lands in two windows and the month grid draws it twice.
    expect(overlaps(ev, utc(2026, 11, 1), utc(2026, 11, 10))).toBe(false);
  });
});

describe("the view windows", () => {
  it("pads the month grid to whole Sunday-first weeks", () => {
    // Nov 2026 starts Sunday 1 Nov and ends Monday 30 Nov.
    const { from, to } = monthGridWindow(utc(2026, 11, 15));
    expect(from.getUTCDay()).toBe(0);
    expect(to.getUTCDay()).toBe(0);
    const days = (to.getTime() - from.getTime()) / DAY_MS;
    expect(days % 7).toBe(0);
    expect(from.getTime()).toBeLessThanOrEqual(utc(2026, 11, 1).getTime());
    expect(to.getTime()).toBeGreaterThan(utc(2026, 11, 30).getTime());
  });

  it("covers a month that begins mid-week", () => {
    // Dec 2026 begins on a Tuesday, so the grid must reach back into November.
    const { from, to } = monthGridWindow(utc(2026, 12, 15));
    expect(from.getUTCDay()).toBe(0);
    expect(from.getTime()).toBeLessThan(utc(2026, 12, 1).getTime());
    expect((to.getTime() - from.getTime()) / DAY_MS % 7).toBe(0);
  });

  it("gives a 7-day Sunday-first week, a 1-day day, and an n-day rolling window", () => {
    const w = weekWindow(utc(2026, 11, 12));
    expect(w.from.getUTCDay()).toBe(0);
    expect((w.to.getTime() - w.from.getTime()) / DAY_MS).toBe(7);

    const d = dayWindow(utc(2026, 11, 12, 23, 59));
    expect((d.to.getTime() - d.from.getTime()) / DAY_MS).toBe(1);
    expect(d.from.toISOString()).toBe("2026-11-12T00:00:00.000Z");

    const r = rollingWindow(utc(2026, 11, 10, 9, 0), 90);
    expect((r.to.getTime() - r.from.getTime()) / DAY_MS).toBe(90);
  });
});

describe("the zone to store is the name the user gave", () => {
  // Not the name Intl resolves it to: that depends on the runtime (Node 22
  // resolves Asia/Kolkata to Asia/Calcutta, newer engines keep Asia/Kolkata),
  // so these expectations hold on every runtime.
  it("keeps a renamed or linked zone as given", () => {
    expect(storedZoneName("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(storedZoneName("US/Pacific")).toBe("US/Pacific");
    expect(storedZoneName("EST")).toBe("EST");
  });

  it("trims it, and fixes only the case of a listed zone", () => {
    expect(storedZoneName(" Asia/Tokyo ")).toBe("Asia/Tokyo");
    expect(storedZoneName("america/chicago")).toBe("America/Chicago");
    expect(storedZoneName("utc")).toBe("UTC");
  });

  it("refuses a bare UTC offset, which is not a named zone and not every browser takes", () => {
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: "+05:30" })).not.toThrow(); // Node takes it
    expect(storedZoneName("+05:30")).toBeNull();
    expect(storedZoneName("-0800")).toBeNull();
    expect(isIanaZone("+05:30")).toBe(false);
  });

  it("refuses what is not a zone at all", () => {
    expect(storedZoneName("Mars/Olympus_Mons")).toBeNull();
    expect(storedZoneName("")).toBeNull();
    expect(storedZoneName("   ")).toBeNull();
  });

  it("control: a listed name is its own", () => {
    expect(storedZoneName("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(storedZoneName("UTC")).toBe("UTC");
  });
});

describe("the formatter cache", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not grow with strings that are not zones", () => {
    const before = zoneCacheSizes();
    for (let i = 0; i < 500; i++) zoneOffsetMs(new Date(0), `Nowhere/Place_${i}`);
    expect(zoneCacheSizes()).toEqual(before);
  });

  it("keeps one formatter per zone, whatever it was spelled as", () => {
    zoneOffsetMs(new Date(0), "America/Chicago");
    const before = zoneCacheSizes().formatters;
    for (const spelling of ["america/chicago", "AMERICA/CHICAGO", "US/Central", "CST6CDT"]) {
      if (resolved(spelling) === "America/Chicago") zoneOffsetMs(new Date(0), spelling);
    }
    expect(zoneCacheSizes().formatters).toBe(before);
  });

  it("control: a spelling seen once is not rebuilt", () => {
    const canonical = resolved("us/mountain");
    zoneOffsetMs(new Date(0), "us/mountain");
    const built = vi.spyOn(Intl, "DateTimeFormat");
    zoneOffsetMs(new Date(0), "us/mountain");
    zoneOffsetMs(new Date(0), canonical);
    expect(built).not.toHaveBeenCalled();
  });

  const resolved = (z: string) => new Intl.DateTimeFormat("en-US", { timeZone: z }).resolvedOptions().timeZone;
});
