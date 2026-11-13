// @vitest-environment jsdom
//
// The Day and Week views' all-day band. The month view shows three lanes and
// a "+N more" that opens the Day view, so the Day view is where the rest have
// to be. The band once capped itself at three lanes too, with no "+N more" of
// its own, so the fourth item on a day was simply not drawn anywhere.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

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
