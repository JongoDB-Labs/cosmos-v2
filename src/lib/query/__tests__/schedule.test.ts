import { describe, it, expect } from "vitest";
import { checkSchedule, describeSchedule, nextRun, parseSchedule, presetCron, type Schedule } from "../schedule";

const s = (cron: string) => {
  const r = parseSchedule(cron);
  if ("error" in r) throw new Error(r.error);
  return r as Schedule;
};
const next = (cron: string, tz: string, after: string) => nextRun(s(cron), tz, new Date(after))?.toISOString() ?? null;

describe("parseSchedule", () => {
  it.each([
    ["0 8 * * 1-5"],
    ["30 */2 * * *"],
    ["0 8,12,17 1,15 * *"],
    ["0 9 * * 0"],
    ["0 9 * * 7"],
    ["5 0 1 1-12/3 *"],
  ])("accepts %s", (cron) => {
    expect(parseSchedule(cron)).not.toHaveProperty("error");
  });

  it.each([
    ["* 8 * * *", /single number/],
    ["*/15 8 * * *", /single number/],
    ["0 8 * *", /five fields/],
    ["0 24 * * *", /between 0 and 23/],
    ["0 8 0 * *", /between 1 and 31/],
    ["0 8 * * mon", /isn't a number/],
    ["0 8 5-1 * *", /between/],
    ["0 8 */0 * *", /at least 1/],
  ])("refuses %s", (cron, why) => {
    expect((parseSchedule(cron) as { error: string }).error).toMatch(why);
  });

  it("7 and 0 are both Sunday", () => {
    expect([...s("0 9 * * 7").weekdays]).toEqual([0]);
  });
});

describe("nextRun", () => {
  it("weekdays at 08:00 in New York: Friday evening runs on Monday", () => {
    // Fri 2026-10-23 22:00 UTC = 18:00 EDT.
    expect(next("0 8 * * 1-5", "America/New_York", "2026-10-23T22:00:00Z")).toBe("2026-10-26T12:00:00.000Z");
  });

  it("is strictly after, and respects the zone's minute (India is +05:30)", () => {
    expect(next("0 8 * * *", "UTC", "2026-10-23T08:00:00Z")).toBe("2026-10-24T08:00:00.000Z");
    expect(next("0 9 * * *", "Asia/Kolkata", "2026-10-23T00:00:00Z")).toBe("2026-10-23T03:30:00.000Z");
  });

  it("follows DST: 08:00 London is 07:00 UTC in summer, 08:00 in winter", () => {
    expect(next("0 8 * * *", "Europe/London", "2026-10-24T12:00:00Z")).toBe("2026-10-25T08:00:00.000Z");
    expect(next("0 8 * * *", "Europe/London", "2026-10-23T12:00:00Z")).toBe("2026-10-24T07:00:00.000Z");
  });

  it("both day fields restricted: either matches (cron's OR rule)", () => {
    // The 1st, or any Monday: after Thu 2026-10-22 the next is Mon 26th.
    expect(next("0 8 1 * 1", "UTC", "2026-10-22T09:00:00Z")).toBe("2026-10-26T08:00:00.000Z");
    // Day of month only.
    expect(next("0 8 1 * *", "UTC", "2026-10-22T09:00:00Z")).toBe("2026-11-01T08:00:00.000Z");
  });

  it("a date that never comes is null, and checkSchedule says so", () => {
    expect(next("0 8 31 2 *", "UTC", "2026-01-01T00:00:00Z")).toBeNull();
    expect(checkSchedule("0 8 31 2 *", "UTC")).toEqual({ error: "That schedule never runs in the next year." });
    expect(checkSchedule("0 8 * * *", "Mars/Olympus")).toEqual({ error: '"Mars/Olympus" isn\'t a time zone.' });
  });
});

describe("describeSchedule", () => {
  it.each([
    ["0 8 * * 1-5", "Weekdays at 08:00"],
    ["30 7 * * *", "Every day at 07:30"],
    ["0 9 * * 1", "Every Monday at 09:00"],
    ["0 9 1 * *", "Monthly on day 1 at 09:00"],
    ["0 8,17 * * *", "Custom (0 8,17 * * *)"],
  ])("%s → %s", (cron, text) => {
    expect(describeSchedule(cron)).toBe(text);
  });
});

describe("presetCron", () => {
  it.each([
    ["weekdays", "08:00", "0 8 * * 1-5"],
    ["daily", "07:45", "45 7 * * *"],
    ["weekly", "09:30", "30 9 * * 3"],
    ["monthly", "18:05", "5 18 15 * *"],
    ["custom", "08:00", "0 6 * * 2"],
  ] as const)("%s at %s → %s", (preset, time, cron) => {
    expect(presetCron(preset, time, 3, 15, " 0 6 * * 2 ")).toBe(cron);
  });
});
