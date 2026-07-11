import { describe, it, expect } from "vitest";
import {
  INACTIVITY_GAP_MS,
  startsNewTimeGroup,
  formatMinuteTime,
  formatPreciseTimestamp,
} from "./message-time";

// Build an ISO instant from LOCAL wall-clock parts so the day/gap assertions are
// evaluated in the same timezone the functions read in — keeps the test stable
// regardless of the runner's TZ.
function iso(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi = 0,
  s = 0,
): string {
  return new Date(y, mo, d, h, mi, s).toISOString();
}

describe("startsNewTimeGroup (FR 78b5b1bd)", () => {
  it("is true for the very first message (no previous)", () => {
    expect(startsNewTimeGroup(null, iso(2026, 0, 1, 9))).toBe(true);
    expect(startsNewTimeGroup(undefined, iso(2026, 0, 1, 9))).toBe(true);
  });

  it("suppresses the timestamp for messages in the same burst", () => {
    // Same author-agnostic burst: 4 minutes later, same day → grouped, no time.
    expect(startsNewTimeGroup(iso(2026, 0, 1, 9, 0), iso(2026, 0, 1, 9, 4))).toBe(
      false,
    );
    // Just under the gap threshold on the same day.
    expect(
      startsNewTimeGroup(iso(2026, 0, 1, 9, 0), iso(2026, 0, 1, 11, 59)),
    ).toBe(false);
  });

  it("shows a fresh timestamp after the inactivity gap within a day", () => {
    // Exactly the threshold (3h) counts as a new group.
    expect(startsNewTimeGroup(iso(2026, 0, 1, 9, 0), iso(2026, 0, 1, 12, 0))).toBe(
      true,
    );
    // Well past the threshold.
    expect(startsNewTimeGroup(iso(2026, 0, 1, 9, 0), iso(2026, 0, 1, 17, 0))).toBe(
      true,
    );
  });

  it("shows a fresh timestamp for the first message of a new day", () => {
    // Different calendar day even though only 90 minutes elapsed.
    expect(
      startsNewTimeGroup(iso(2026, 0, 1, 23, 30), iso(2026, 0, 2, 1, 0)),
    ).toBe(true);
  });

  it("applies a 3-hour gap threshold consistently", () => {
    expect(INACTIVITY_GAP_MS).toBe(3 * 60 * 60 * 1000);
  });
});

describe("timestamp formatting", () => {
  // Seconds are timezone-invariant, so assert on them without pinning the TZ.
  const at = iso(2026, 0, 2, 9, 7, 45);

  it("formatMinuteTime omits seconds (AC: minute granularity)", () => {
    expect(formatMinuteTime(at)).not.toContain("45");
    expect(formatMinuteTime(at)).toMatch(/\d{1,2}:\d{2}/);
  });

  it("formatPreciseTimestamp includes seconds (AC: precise on demand)", () => {
    expect(formatPreciseTimestamp(at)).toContain("45");
  });
});
