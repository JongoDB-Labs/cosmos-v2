import { describe, it, expect } from "vitest";
import {
  NO_PAN,
  PAN_CHUNK_DAYS,
  PAN_EDGE_PX,
  fillerDays,
  grownPan,
  panIntent,
  sameDayWindow,
  visibleDayWindow,
} from "./timeline-pan";

describe("panIntent", () => {
  const metrics = (over: Partial<Parameters<typeof panIntent>[0]>) => ({
    scrollLeft: 1000,
    previousScrollLeft: 1000,
    scrollWidth: 5000,
    clientWidth: 800,
    ...over,
  });

  it("asks for earlier days when a leftward scroll lands on the left edge", () => {
    expect(panIntent(metrics({ previousScrollLeft: 900, scrollLeft: 10 }))).toBe("before");
  });

  it("asks for later days when a rightward scroll lands on the right edge", () => {
    // scrollWidth - clientWidth = 4200 is the maximum offset.
    expect(panIntent(metrics({ previousScrollLeft: 3000, scrollLeft: 4150 }))).toBe("after");
  });

  it("stays put mid-chart in either direction", () => {
    expect(panIntent(metrics({ previousScrollLeft: 2000, scrollLeft: 1000 }))).toBeNull();
    expect(panIntent(metrics({ previousScrollLeft: 1000, scrollLeft: 2000 }))).toBeNull();
  });

  it("ignores a purely vertical scroll sitting at the left edge", () => {
    // The rows and the chart share one scroller, so scrolling DOWN a board that
    // starts at offset 0 fires this with both edges 'reached'. Only travel
    // counts — otherwise every wheel-tick down would invent another quarter.
    expect(panIntent(metrics({ previousScrollLeft: 0, scrollLeft: 0, scrollWidth: 800 })))
      .toBeNull();
  });

  it("treats the edge band as inclusive on both sides", () => {
    expect(panIntent(metrics({ previousScrollLeft: 900, scrollLeft: PAN_EDGE_PX }))).toBe(
      "before",
    );
    expect(
      panIntent(metrics({ previousScrollLeft: 900, scrollLeft: PAN_EDGE_PX + 1 })),
    ).toBeNull();
  });
});

describe("grownPan", () => {
  it("adds a quarter to the named side and leaves the other alone", () => {
    expect(grownPan(NO_PAN, "before")).toEqual({ before: PAN_CHUNK_DAYS, after: 0 });
    expect(grownPan({ before: 90, after: 0 }, "after")).toEqual({
      before: 90,
      after: PAN_CHUNK_DAYS,
    });
  });

  it("accumulates, so the axis keeps opening out reach after reach", () => {
    let pan = NO_PAN;
    for (let i = 0; i < 4; i++) pan = grownPan(pan, "before");
    expect(pan.before).toBe(4 * PAN_CHUNK_DAYS);
  });
});

describe("fillerDays", () => {
  it("tops a short chart up until it overflows its viewport", () => {
    // 1200px of viewport, 900px of chart, 28px days: 300px + the edge band short.
    expect(fillerDays(1200, 900, 28)).toBe(Math.ceil((1200 + PAN_EDGE_PX - 900) / 28));
  });

  it("adds nothing once the chart already overflows", () => {
    expect(fillerDays(800, 5000, 28)).toBe(0);
  });

  it("adds nothing when the scroller cannot be measured", () => {
    // SSR / jsdom / a hidden tab report 0 — growing the axis off that would run
    // away, because the days added never widen anything back.
    expect(fillerDays(0, 0, 28)).toBe(0);
    expect(fillerDays(1200, 0, 0)).toBe(0);
  });
});

describe("visibleDayWindow", () => {
  it("draws every day until the scroller has been measured", () => {
    expect(visibleDayWindow({ scrollLeft: 0, clientWidth: 0, dayWidth: 28, totalDays: 400 }))
      .toEqual({ from: 0, to: 400 });
  });

  it("covers the viewport with a chunk of slack on each side", () => {
    // Day 200-ish is on screen: the window has to contain it, start before it
    // and end after it, without running past the axis.
    const w = visibleDayWindow({
      scrollLeft: 200 * 28,
      clientWidth: 840,
      dayWidth: 28,
      totalDays: 1000,
    });
    expect(w.from).toBeLessThanOrEqual(200);
    expect(w.to).toBeGreaterThanOrEqual(230);
    expect(w.from).toBeGreaterThan(0);
    expect(w.to).toBeLessThan(1000);
  });

  it("clamps to the axis at both ends", () => {
    const w = visibleDayWindow({
      scrollLeft: -500,
      clientWidth: 840,
      dayWidth: 28,
      totalDays: 60,
    });
    expect(w).toEqual({ from: 0, to: 60 });
  });

  it("is quantised, so panning within a chunk doesn't re-render the chart", () => {
    const at = (px: number) =>
      visibleDayWindow({ scrollLeft: px, clientWidth: 840, dayWidth: 28, totalDays: 1000 });
    expect(sameDayWindow(at(200 * 28), at(205 * 28))).toBe(true);
    expect(sameDayWindow(at(200 * 28), at(500 * 28))).toBe(false);
  });
});
