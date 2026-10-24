// COSMOS-202: the feed link's secret is 32 random bytes in the PATH, and only
// its hash is ever stored.
import { describe, it, expect } from "vitest";
import { feedPath, hashFeedToken, newFeedToken, parseFeedSegment } from "./feed-token";
import { calendarFeedsEnabled, readFeedOptions, withCalendarFeedsEnabled } from "./feed-settings";

describe("feed tokens", () => {
  it("are 43 URL-safe characters, unique, stored only as their SHA-256", () => {
    const a = newFeedToken();
    const b = newFeedToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).toBe(hashFeedToken(a.token));
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.tokenHash).not.toContain(a.token);
  });

  it("round-trips through the .ics path segment, and rejects anything else", () => {
    const { token } = newFeedToken();
    expect(feedPath(token)).toBe(`/api/v1/calendar/feeds/${token}.ics`);
    expect(parseFeedSegment(`${token}.ics`)).toBe(token);
    expect(parseFeedSegment(token)).toBe(token);
    expect(parseFeedSegment("short.ics")).toBeNull();
    expect(parseFeedSegment(`${token.slice(0, 42)}%.ics`)).toBeNull();
    expect(parseFeedSegment(`../${token}.ics`)).toBeNull();
  });
});

describe("feed settings", () => {
  it("is OFF unless an admin turned it on explicitly", () => {
    expect(calendarFeedsEnabled({})).toBe(false);
    expect(calendarFeedsEnabled(null)).toBe(false);
    expect(calendarFeedsEnabled({ calendarFeeds: { enabled: "yes" } })).toBe(false);
    expect(calendarFeedsEnabled(withCalendarFeedsEnabled({ other: 1 }, true))).toBe(true);
    expect(withCalendarFeedsEnabled({ other: 1 }, true)).toMatchObject({ other: 1 });
  });

  it("defaults each option on its own, so an old or odd row still reads", () => {
    expect(readFeedOptions(null)).toEqual({ workItems: true, meetings: true, intervals: false, busyOnly: false });
    expect(readFeedOptions({ busyOnly: true, meetings: "no" })).toEqual({
      workItems: true, meetings: true, intervals: false, busyOnly: true,
    });
  });
});
