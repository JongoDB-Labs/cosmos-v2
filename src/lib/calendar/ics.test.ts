// COSMOS-202: the feed Outlook subscribes to must be valid RFC 5545, or the
// subscription silently shows nothing.
import { describe, it, expect } from "vitest";
import { buildIcs, escapeText, foldLine, formatDate, formatUtc } from "./ics";

const STAMP = new Date("2026-10-22T12:00:00.000Z");

describe("buildIcs", () => {
  const ics = buildIcs({
    prodId: "-//Test//Feed//EN",
    name: "My work",
    stamp: STAMP,
    events: [
      {
        uid: "workitem-1@example.com",
        summary: "ALPHA-7 Ship it",
        start: new Date("2026-10-23T00:00:00Z"),
        end: new Date("2026-10-25T00:00:00Z"),
        allDay: true,
        url: "https://example.com/alpha/issues/ALPHA-7",
      },
      {
        uid: "meeting-2@example.com",
        summary: "Standup",
        start: new Date("2026-10-23T14:30:00Z"),
        end: new Date("2026-10-23T15:00:00Z"),
        allDay: false,
      },
    ],
  });
  const lines = ics.split("\r\n");

  it("is a CRLF-delimited VCALENDAR ending in CRLF", () => {
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("METHOD:PUBLISH");
    expect(lines).toContain("X-WR-CALNAME:My work");
    expect(lines).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT60M");
  });

  it("writes all-day events as DATE values with an exclusive end", () => {
    expect(lines).toContain("DTSTART;VALUE=DATE:20261023");
    expect(lines).toContain("DTEND;VALUE=DATE:20261025");
  });

  it("writes timed events in UTC", () => {
    expect(lines).toContain("DTSTART:20261023T143000Z");
    expect(lines).toContain("DTEND:20261023T150000Z");
  });

  it("stamps every event and balances BEGIN/END", () => {
    expect(lines.filter((l) => l === "DTSTAMP:20261022T120000Z")).toHaveLength(2);
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(2);
    expect(lines.filter((l) => l === "END:VEVENT")).toHaveLength(2);
  });

  it("is byte-for-byte reproducible for the same input (stable ETags)", () => {
    const again = buildIcs({ prodId: "-//Test//Feed//EN", name: "My work", stamp: STAMP, events: [] });
    expect(again).toBe(buildIcs({ prodId: "-//Test//Feed//EN", name: "My work", stamp: STAMP, events: [] }));
  });
});

describe("escapeText", () => {
  it("escapes the characters RFC 5545 reserves in TEXT", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\;c\\\\d\\ne");
  });
});

describe("foldLine", () => {
  const enc = new TextEncoder();

  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:short")).toBe("SUMMARY:short");
  });

  it("folds at 75 octets and unfolds back to the original", () => {
    const long = "SUMMARY:" + "x".repeat(200);
    const folded = foldLine(long);
    for (const part of folded.split("\r\n")) expect(enc.encode(part).length).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("counts UTF-8 bytes and never splits a character", () => {
    const long = "SUMMARY:" + "é".repeat(60) + "🚀".repeat(10);
    const folded = foldLine(long);
    for (const part of folded.split("\r\n")) {
      expect(enc.encode(part).length).toBeLessThanOrEqual(75);
      expect(part).not.toMatch(/�/);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });
});

describe("dates", () => {
  it("formats in UTC whatever the server's zone", () => {
    expect(formatUtc(new Date("2026-01-02T03:04:05Z"))).toBe("20260102T030405Z");
    expect(formatDate(new Date("2026-01-02T23:59:00Z"))).toBe("20260102");
  });
});
