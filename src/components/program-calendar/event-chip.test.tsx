// @vitest-environment jsdom
//
// The kind label is sr-only, which is `position: absolute`. A chip that is not
// itself positioned lets that label be placed against the page: from a chip
// near the right edge it widened the whole document on a phone (390px wide,
// 484px of scroll). jsdom has no layout, so the measurement lives in the
// localhost drive; this pins the class that fixes it.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { EventChip } from "./event-chip";

const CATEGORY = { id: "c", name: "Sprint", tintRgb: "14 165 233", tintAlpha: 0.2, textColor: "#075985" };

afterEach(cleanup);

describe("a chip with a spoken kind", () => {
  it("is positioned, so its sr-only label stays inside it", () => {
    const { container } = render(<EventChip title="Sprint 4" category={CATEGORY} kind="sprint" />);
    const label = [...container.querySelectorAll(".sr-only")].find((n) => n.textContent === "Sprint: ");
    expect(label).toBeTruthy();
    const chip = label!.closest(".pc-chip") as HTMLElement;
    expect(chip.className.split(/\s+/)).toContain("relative");
  });
});

describe("a stored time zone Intl does not know", () => {
  // The routes took any string as a zone, and the chip passed it straight to
  // Intl, which throws: one such row took the calendar down for every viewer.
  const at = new Date("2027-01-12T03:00:00.000Z");

  it("reads as UTC, as the grid reads it, instead of throwing", () => {
    const { container } = render(
      <EventChip title="Bad zone review" category={CATEGORY} startsAt={at} allDay={false} timeZone="Mars/Olympus_Mons" />,
    );
    expect(container.querySelector(".pc-chip")?.textContent).toContain("03:00");
  });

  it("control: a real zone shows the time on that zone's clock", () => {
    const { container } = render(
      <EventChip title="West coast review" category={CATEGORY} startsAt={at} allDay={false} timeZone="America/Los_Angeles" />,
    );
    expect(container.querySelector(".pc-chip")?.textContent).toContain("19:00");
  });
});
