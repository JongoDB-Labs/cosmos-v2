// @vitest-environment jsdom
//
// The Day and Week views' all-day band. The month view shows three lanes and
// a "+N more" that opens the Day view, so the Day view is where the rest have
// to be. The band once capped itself at three lanes too, with no "+N more" of
// its own, so the fourth item on a day was simply not drawn anywhere.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/program-management" }));

import { TimeGrid } from "./time-grid";
import { MonthGrid, type CalendarEvent } from "./month-grid";

const CATEGORY = { id: "c1", name: "Reviews", tintRgb: "99 102 241", tintAlpha: 0.2, textColor: "#3730A3" };
const DAY = new Date("2027-01-12T00:00:00.000Z");
const allDay = (id: string, title: string): CalendarEvent => ({
  id,
  title,
  startsAt: DAY,
  endsAt: new Date("2027-01-13T00:00:00.000Z"),
  allDay: true,
  timeZone: "UTC",
  category: CATEGORY,
});

afterEach(cleanup);

describe("the all-day band", () => {
  it("draws every all-day item on a day, not the first three", () => {
    const titles = ["Program review", "Exercise A", "Readiness check", "Planning", "Retrospective"];
    render(<TimeGrid days={[DAY]} events={titles.map((t, i) => allDay(`e${i}`, t))} />);
    for (const t of titles) expect(screen.getByText(t)).toBeTruthy();
  });

  it("control: the month view, which does cap, hides the same items behind \"+2 more\"", () => {
    const titles = ["Program review", "Exercise A", "Readiness check", "Planning", "Retrospective"];
    render(
      <MonthGrid
        from={new Date("2027-01-10T00:00:00.000Z")}
        to={new Date("2027-01-17T00:00:00.000Z")}
        month={0}
        events={titles.map((t, i) => allDay(`e${i}`, t))}
      />,
    );
    expect(screen.getByRole("button", { name: "+2 more" })).toBeTruthy();
    expect(titles.filter((t) => screen.queryByText(t)).length).toBe(3);
  });
});

describe("the hour grid puts a timed event on the day it is held", () => {
  // The grid read the hour on the event's own clock and the column on UTC's,
  // so a 19:00 review in Los Angeles sat at 19:00 in the NEXT day's column.
  // The machine's zone is forced away from UTC: CI runs in UTC, and a rule
  // that leaned on the machine's clock would pass there by accident.
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  // Sunday 8 to Saturday 14 Nov 2026, as the Week view passes them.
  const WEEK_DAYS = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 10, 8 + i)));
  const timed = (id: string, title: string, startIso: string, endIso: string, timeZone: string): CalendarEvent => ({
    id, title, startsAt: new Date(startIso), endsAt: new Date(endIso), allDay: false, timeZone, category: CATEGORY,
  });
  /** The grid column (1 is the hour labels) and top offset a chip was drawn at. */
  const drawnAt = (title: string) => {
    const hours = screen.getByRole("group", { name: "Hours" });
    const chip = within(hours).getByText(title).closest("[style*='top']") as HTMLElement;
    const column = chip.parentElement as HTMLElement;
    return { column: column.style.gridColumn, top: chip.style.top };
  };

  it.each(["America/New_York", "Asia/Kolkata"])("an evening in Los Angeles, under TZ=%s", (zone) => {
    process.env.TZ = zone;
    expect(new Date(2026, 0, 1).toISOString()).not.toBe("2026-01-01T00:00:00.000Z");
    // Tuesday 10 Nov, 19:00-20:00 PST is 03:00-04:00 UTC on Wednesday.
    render(
      <TimeGrid
        days={WEEK_DAYS}
        events={[timed("la", "West coast review", "2026-11-11T03:00:00Z", "2026-11-11T04:00:00Z", "America/Los_Angeles")]}
      />,
    );
    // Tuesday is the third day, so the fourth grid column.
    expect(drawnAt("West coast review")).toEqual({ column: "4", top: `${19 * 48}px` });
  });

  it("a morning in Tokyo, which is still the day before in UTC", () => {
    // Wednesday 11 Nov, 08:00 in Tokyo is 23:00 UTC on Tuesday.
    render(
      <TimeGrid
        days={WEEK_DAYS}
        events={[timed("tk", "Far east sync", "2026-11-10T23:00:00Z", "2026-11-11T00:00:00Z", "Asia/Tokyo")]}
      />,
    );
    expect(drawnAt("Far east sync")).toEqual({ column: "5", top: `${8 * 48}px` });
  });

  it("an afternoon that crosses UTC midnight stays in the hour grid", () => {
    // 15:00-17:00 in Los Angeles is 23:00-01:00 UTC: two UTC days, one local
    // afternoon. Read on UTC's clock it looked multi-day and went to the band.
    render(
      <TimeGrid
        days={WEEK_DAYS}
        events={[timed("pm", "Afternoon review", "2026-11-10T23:00:00Z", "2026-11-11T01:00:00Z", "America/Los_Angeles")]}
      />,
    );
    expect(drawnAt("Afternoon review")).toEqual({ column: "4", top: `${15 * 48}px` });
  });

  it("control: an event in UTC is drawn where it always was", () => {
    render(
      <TimeGrid
        days={WEEK_DAYS}
        events={[timed("u", "UTC standup", "2026-11-11T09:30:00Z", "2026-11-11T10:00:00Z", "UTC")]}
      />,
    );
    expect(drawnAt("UTC standup")).toEqual({ column: "5", top: `${9.5 * 48}px` });
  });
});
