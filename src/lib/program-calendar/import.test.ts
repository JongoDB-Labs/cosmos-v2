// @vitest-environment node
//
// What a spreadsheet row means to the program calendar — the pure half.
//
// These are the rules a database cannot check: that a date cell is read as a
// DATE rather than through `new Date()` (which would silently use the importing
// machine's zone), that a wall clock is converted in the EVENT's zone across a
// DST boundary, and that a zone label a human typed becomes something
// `Intl.DateTimeFormat` will accept — it throws on anything else, and the chip
// renderer hands it the stored value directly.
import { afterEach, describe, it, expect } from "vitest";
import {
  DEFAULT_EVENT_TIME_ZONE,
  dayKey,
  eventDayKey,
  eventRangeFromRow,
  parseSheetDate,
  parseSheetTime,
  resolveTimeZone,
  zonedInstant,
} from "./import";

const iso = (d: Date) => d.toISOString();

describe("time zones", () => {
  it("accepts an IANA zone unchanged", () => {
    expect(resolveTimeZone("America/New_York")).toBe("America/New_York");
    expect(resolveTimeZone(" UTC ")).toBe("UTC");
  });

  it("translates the spellings the real exports carry", () => {
    // Both files in hand: the xlsx writes "Eastern (ET)", the CSV an IANA zone.
    expect(resolveTimeZone("Eastern (ET)")).toBe("America/New_York");
    expect(resolveTimeZone("ET")).toBe("America/New_York");
    expect(resolveTimeZone("Pacific Time")).toBe("America/Los_Angeles");
    // "GMT" needs no translation: Intl accepts it as a zone, so it passes
    // through — the rule is "something Intl will take", not "an Area/City name".
    expect(resolveTimeZone("GMT")).toBe("GMT");
  });

  it("rejects a label that means nothing, rather than storing it", () => {
    expect(resolveTimeZone("Narnia/Lamppost")).toBeNull();
    expect(resolveTimeZone("")).toBeNull();
  });

  it("is worth doing: an unknown zone THROWS where the chip renders it", () => {
    // The positive control for the rule above. `event-chip.tsx` passes the
    // stored value to Intl, so storing "Eastern (ET)" is not a cosmetic wrong
    // label — it takes the calendar down.
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: "Eastern (ET)" })).toThrow();
    expect(() => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York" })).not.toThrow();
  });
});

describe("reading a sheet's dates and times", () => {
  it("reads the three shapes the real files and their neighbours use", () => {
    expect(parseSheetDate("2026-10-01")).toEqual({ y: 2026, m: 10, d: 1 });
    expect(parseSheetDate("10/27/2026")).toEqual({ y: 2026, m: 10, d: 27 });
    expect(parseSheetDate("9-Nov-2026")).toEqual({ y: 2026, m: 11, d: 9 });
    expect(parseSheetDate("Nov 9, 2026")).toEqual({ y: 2026, m: 11, d: 9 });
    expect(parseSheetDate("2026-10-01T00:00:00.000Z")).toEqual({ y: 2026, m: 10, d: 1 });
  });

  it("returns null for something that is not a date", () => {
    expect(parseSheetDate("TBD")).toBeNull();
    expect(parseSheetDate("")).toBeNull();
    // Rolled-over parts would be a WRONG date, which is worse than no date.
    expect(parseSheetDate("13/40/2026")).toBeNull();
  });

  it("reads times with and without a meridiem", () => {
    expect(parseSheetTime("09:00")).toEqual({ hh: 9, mm: 0 });
    expect(parseSheetTime("15:30")).toEqual({ hh: 15, mm: 30 });
    expect(parseSheetTime("9:30 AM")).toEqual({ hh: 9, mm: 30 });
    expect(parseSheetTime("4 pm")).toEqual({ hh: 16, mm: 0 });
    expect(parseSheetTime("12:00 AM")).toEqual({ hh: 0, mm: 0 });
    expect(parseSheetTime("noon")).toBeNull();
    expect(parseSheetTime("")).toBeNull();
  });

  it("converts a wall clock in the event's zone, on both sides of DST", () => {
    // November is EST (UTC-5), July is EDT (UTC-4). A single fixed offset gets
    // one of these wrong, which is the whole reason this is not arithmetic.
    expect(iso(zonedInstant(2026, 11, 10, 9, 0, "America/New_York"))).toBe("2026-11-10T14:00:00.000Z");
    expect(iso(zonedInstant(2026, 7, 1, 9, 0, "America/New_York"))).toBe("2026-07-01T13:00:00.000Z");
    expect(iso(zonedInstant(2026, 11, 10, 9, 0, "UTC"))).toBe("2026-11-10T09:00:00.000Z");
  });

  it("lands on the right side of a spring-forward morning", () => {
    // 2026-03-08: clocks jump 02:00 EST → 03:00 EDT at 07:00Z. A 03:30 wall
    // clock is 07:30Z, but the first offset measurement happens at 03:30Z —
    // still EST — and would place it an hour late at 08:30Z. This is the one
    // assertion the correcting second measurement exists for.
    expect(iso(zonedInstant(2026, 3, 8, 3, 30, "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
  });
});

describe("a row's stored range", () => {
  const row = (fields: Record<string, unknown>) => eventRangeFromRow(fields)!;

  it("stores a one-day all-day event as midnight to the NEXT midnight", () => {
    // The end date is inclusive as the sheet writes it; `normalizeRange` owns
    // the conversion and this proves the import goes through it.
    const { range } = row({ startDate: "2026-10-01", endDate: "2026-10-01", allDay: true });
    expect(iso(range.startsAt)).toBe("2026-10-01T00:00:00.000Z");
    expect(iso(range.endsAt)).toBe("2026-10-02T00:00:00.000Z");
    expect(range.allDay).toBe(true);
  });

  it("keeps a multi-day all-day event's last day inside the range", () => {
    const { range } = row({ startDate: "11/09/2026", endDate: "11/10/2026", allDay: true });
    expect(iso(range.startsAt)).toBe("2026-11-09T00:00:00.000Z");
    expect(iso(range.endsAt)).toBe("2026-11-11T00:00:00.000Z");
  });

  it("defaults the end date to the start, and all-day to true with no time", () => {
    const { range } = row({ startDate: "2027-03-31" });
    expect(iso(range.startsAt)).toBe("2027-03-31T00:00:00.000Z");
    expect(iso(range.endsAt)).toBe("2027-04-01T00:00:00.000Z");
    expect(range.allDay).toBe(true);
    expect(range.timeZone).toBe(DEFAULT_EVENT_TIME_ZONE);
  });

  it("combines date + time in the row's own zone for a timed event", () => {
    const { range } = row({
      startDate: "11/10/2026", endDate: "11/10/2026",
      startTime: "09:00", endTime: "10:00",
      allDay: false, timeZone: "Eastern (ET)",
    });
    expect(iso(range.startsAt)).toBe("2026-11-10T14:00:00.000Z");
    expect(iso(range.endsAt)).toBe("2026-11-10T15:00:00.000Z");
    expect(range.timeZone).toBe("America/New_York");
  });

  it("treats a row with a start time but no All day column as timed", () => {
    const { range } = row({ startDate: "2026-11-10", startTime: "09:00", timeZone: "UTC" });
    expect(range.allDay).toBe(false);
    expect(iso(range.startsAt)).toBe("2026-11-10T09:00:00.000Z");
  });

  it("keeps an existing all-day event all-day when the sheet omits the column", () => {
    const built = eventRangeFromRow(
      { startDate: "2026-11-10" },
      { allDay: true, timeZone: "America/Chicago" },
    )!;
    expect(built.range.allDay).toBe(true);
    expect(built.range.timeZone).toBe("America/Chicago");
  });

  it("keeps an existing TIMED event timed when the sheet omits the column", () => {
    // The sibling of the case above, and the one that discriminates: with a
    // fixture whose current flag is `true` the fallback is indistinguishable
    // from a hardcoded `true`.
    const built = eventRangeFromRow(
      { startDate: "2026-11-10" },
      { allDay: false, timeZone: "UTC" },
    )!;
    expect(built.range.allDay).toBe(false);
    expect(iso(built.range.startsAt)).toBe("2026-11-10T00:00:00.000Z");
  });

  it("warns — rather than failing the row — on an unusable zone or time", () => {
    const built = row({ startDate: "2026-11-10", startTime: "half past nine", timeZone: "Narnia" });
    expect(built.warnings.join(" ")).toMatch(/Narnia/);
    expect(built.warnings.join(" ")).toMatch(/half past nine/);
    expect(built.range.timeZone).toBe(DEFAULT_EVENT_TIME_ZONE);
  });

  it("has no range at all without a readable start date", () => {
    expect(eventRangeFromRow({ startDate: "TBD" })).toBeNull();
    expect(eventRangeFromRow({})).toBeNull();
  });
});

/**
 * The rule the whole module exists for, tested where it can actually fail.
 *
 * CI runs UTC, and under UTC a local-midnight parse and a UTC one agree — so a
 * regression to `new Date("10/27/2026")` would be invisible there forever, and
 * visible on a developer's machine as a date one day out. Verified by mutation:
 * building the all-day start from local midnight fails four specs under
 * TZ=Asia/Tokyo and NONE under TZ=UTC. So the test forces the zone itself,
 * with a control that fails if the zone did not take.
 */
describe("the importing machine's zone cannot move a date", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  it.each(["Asia/Tokyo", "America/Los_Angeles", "Asia/Kolkata"])(
    "reads the same instants under TZ=%s",
    (zone) => {
      process.env.TZ = zone;
      // Control: east, west and a half-hour offset all shift this instant, so
      // the spec cannot pass by having failed to change the zone.
      expect(new Date(2026, 0, 1).toISOString()).not.toBe("2026-01-01T00:00:00.000Z");

      const { range } = eventRangeFromRow({
        startDate: "10/27/2026", endDate: "11/16/2026", allDay: true,
      })!;
      expect(iso(range.startsAt)).toBe("2026-10-27T00:00:00.000Z");
      expect(iso(range.endsAt)).toBe("2026-11-17T00:00:00.000Z");
      // And a timed row: its zone is the EVENT's, never the machine's.
      expect(iso(zonedInstant(2026, 11, 10, 9, 0, "America/New_York"))).toBe("2026-11-10T14:00:00.000Z");
    },
  );
});

describe("the day an event is on (the title + date natural key)", () => {
  it("reads an all-day event's day in UTC", () => {
    const { range } = eventRangeFromRow({ startDate: "2026-11-09", allDay: true })!;
    expect(eventDayKey(range.startsAt, range.allDay, range.timeZone)).toBe("2026-11-09");
  });

  it("reads a timed event's day in ITS zone, not UTC", () => {
    // 9pm Eastern is stored as the NEXT UTC day. Reading the key in UTC would
    // make a re-import of the same row look new and duplicate the event — the
    // precise failure the external-id-less path has to avoid.
    const { range } = eventRangeFromRow({
      startDate: "2026-11-10", startTime: "21:00", allDay: false, timeZone: "Eastern (ET)",
    })!;
    expect(iso(range.startsAt)).toBe("2026-11-11T02:00:00.000Z");
    expect(range.startsAt.toISOString().slice(0, 10)).toBe("2026-11-11"); // the trap
    expect(eventDayKey(range.startsAt, range.allDay, range.timeZone)).toBe("2026-11-10");
  });

  it("formats parts with no zone involved", () => {
    expect(dayKey({ y: 2026, m: 1, d: 5 })).toBe("2026-01-05");
  });
});
