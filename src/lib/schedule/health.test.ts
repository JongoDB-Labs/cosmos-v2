import { describe, it, expect } from "vitest";
import { healthOf, slipDays } from "./health";

const d = (s: string) => new Date(s);
const NOW = d("2026-03-15T00:00:00Z");

describe("healthOf — the one coloring rule", () => {
  it("neutral when there is no projected end (not started / no dates)", () => {
    expect(healthOf({ projectedEnd: null, actualEnd: null, now: NOW })).toBe("neutral");
    expect(healthOf({ projectedEnd: null, actualEnd: d("2026-01-01"), now: NOW })).toBe("neutral");
  });
  it("green when finished exactly on the projected end (inclusive)", () => {
    expect(healthOf({ projectedEnd: d("2026-03-01"), actualEnd: d("2026-03-01"), now: NOW })).toBe("green");
  });
  it("green when finished ahead of the projected end", () => {
    expect(healthOf({ projectedEnd: d("2026-03-10"), actualEnd: d("2026-03-02"), now: NOW })).toBe("green");
  });
  it("red when finished after the projected end", () => {
    expect(healthOf({ projectedEnd: d("2026-03-01"), actualEnd: d("2026-03-10"), now: NOW })).toBe("red");
  });
  it("red when still open and today is past the projected end", () => {
    expect(healthOf({ projectedEnd: d("2026-03-01"), actualEnd: null, now: NOW })).toBe("red");
  });
  it("green when still open and today is on/before the projected end", () => {
    expect(healthOf({ projectedEnd: d("2026-03-31"), actualEnd: null, now: NOW })).toBe("green");
    expect(healthOf({ projectedEnd: NOW, actualEnd: null, now: NOW })).toBe("green");
  });
});

describe("slipDays — variance in whole days", () => {
  it("null when there is no projected end", () => {
    expect(slipDays({ projectedEnd: null, actualEnd: d("2026-01-01"), now: NOW })).toBeNull();
  });
  it("positive when the actual end is late", () => {
    expect(slipDays({ projectedEnd: d("2026-03-01"), actualEnd: d("2026-03-06"), now: NOW })).toBe(5);
  });
  it("negative when the actual end is early", () => {
    expect(slipDays({ projectedEnd: d("2026-03-10"), actualEnd: d("2026-03-04"), now: NOW })).toBe(-6);
  });
  it("open items measure today vs projected end", () => {
    expect(slipDays({ projectedEnd: d("2026-03-20"), actualEnd: null, now: NOW })).toBe(-5);
    expect(slipDays({ projectedEnd: d("2026-03-05"), actualEnd: null, now: NOW })).toBe(10);
  });
});
