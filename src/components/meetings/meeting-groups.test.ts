import { describe, it, expect } from "vitest";
import { groupMeetingsByWhen, type MeetingGroups } from "./meeting-groups";

// Wednesday 18 November 2026, 20:00 UTC. That is Wednesday noon in Los Angeles
// (UTC-8) and 01:30 on Thursday in Kolkata (UTC+5:30). CI runs in UTC, so
// every case below includes meetings that a UTC calendar would file somewhere
// else: the test only passes if the zone it is given is the one used.
const NOW = new Date("2026-11-18T20:00:00.000Z");

const meeting = (title: string, iso: string) => ({ title, meetingDate: iso });
const titles = (g: MeetingGroups<{ title: string }>) => ({
  today: g.today.map((m) => m.title),
  thisWeek: g.thisWeek.map((m) => m.title),
  upcoming: g.upcoming.map((m) => m.title),
  past: g.past.map((m) => m.title),
});

describe("groupMeetingsByWhen", () => {
  it("files a meeting next month under Upcoming, never Past", () => {
    const g = groupMeetingsByWhen([meeting("next month", "2026-12-18T17:00:00.000Z")], NOW, "America/Los_Angeles");
    expect(titles(g)).toEqual({ today: [], thisWeek: [], upcoming: ["next month"], past: [] });
  });

  it("draws today and this week at the viewer's midnight and Monday (Los Angeles)", () => {
    const g = groupMeetingsByWhen(
      [
        meeting("last month", "2026-10-10T17:00:00.000Z"),
        meeting("last Sunday 23:30", "2026-11-16T07:30:00.000Z"), // Monday 07:30 in UTC
        meeting("Monday 01:00", "2026-11-16T09:00:00.000Z"),
        meeting("today 15:00", "2026-11-18T23:00:00.000Z"),
        meeting("today 23:00", "2026-11-19T07:00:00.000Z"), // Thursday in UTC
        meeting("Sunday 22:30", "2026-11-23T06:30:00.000Z"), // next Monday in UTC
        meeting("next Tuesday", "2026-11-24T17:00:00.000Z"),
        meeting("next month", "2026-12-18T17:00:00.000Z"),
      ],
      NOW,
      "America/Los_Angeles",
    );
    expect(titles(g)).toEqual({
      today: ["today 15:00", "today 23:00"],
      thisWeek: ["Monday 01:00", "Sunday 22:30"],
      upcoming: ["next Tuesday", "next month"],
      past: ["last Sunday 23:30", "last month"],
    });
  });

  it("holds east of UTC and on a half-hour offset too (Kolkata)", () => {
    const g = groupMeetingsByWhen(
      [
        meeting("Monday 00:30", "2026-11-15T19:00:00.000Z"), // Sunday in UTC: Past there
        meeting("Wednesday 23:30", "2026-11-18T18:00:00.000Z"), // today in UTC
        meeting("today 09:30", "2026-11-19T04:00:00.000Z"), // tomorrow in UTC
        meeting("next Monday 00:15", "2026-11-22T18:45:00.000Z"), // still this week in UTC
      ],
      NOW,
      "Asia/Kolkata",
    );
    expect(titles(g)).toEqual({
      today: ["today 09:30"],
      thisWeek: ["Monday 00:30", "Wednesday 23:30"],
      upcoming: ["next Monday 00:15"],
      past: [],
    });
  });

  it("lists Today, This Week and Upcoming soonest first, and Past most recent first", () => {
    // Given out of order, so no order can come from the input.
    const g = groupMeetingsByWhen(
      [
        meeting("Thursday", "2026-11-19T10:00:00.000Z"),
        meeting("two weeks ago", "2026-11-04T10:00:00.000Z"),
        meeting("today 21:00", "2026-11-18T21:00:00.000Z"),
        meeting("next month", "2026-12-18T10:00:00.000Z"),
        meeting("Monday", "2026-11-16T10:00:00.000Z"),
        meeting("last week", "2026-11-11T10:00:00.000Z"),
        meeting("today 09:00", "2026-11-18T09:00:00.000Z"),
        meeting("next week", "2026-11-25T10:00:00.000Z"),
        meeting("Saturday", "2026-11-21T10:00:00.000Z"),
        meeting("today 23:00", "2026-11-18T23:00:00.000Z"),
      ],
      NOW,
      "UTC",
    );
    expect(titles(g)).toEqual({
      today: ["today 09:00", "today 21:00", "today 23:00"],
      thisWeek: ["Monday", "Thursday", "Saturday"],
      upcoming: ["next week", "next month"],
      past: ["last week", "two weeks ago"],
    });
  });

  it("files the same meetings differently in UTC (the zone is what decides)", () => {
    const g = groupMeetingsByWhen(
      [meeting("Sunday 22:30 in Los Angeles", "2026-11-23T06:30:00.000Z")],
      NOW,
      "UTC",
    );
    expect(titles(g).upcoming).toEqual(["Sunday 22:30 in Los Angeles"]);
  });
});
