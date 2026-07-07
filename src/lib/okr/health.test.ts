import { describe, it, expect } from "vitest";
import { objectiveHealth } from "./health";

const DAY = 86400_000;
const now = 1_000_000_000_000; // fixed "now"
const start = now - 10 * DAY; // objective created 10 days ago
const target = now + 10 * DAY; // due in 10 days → 50% of the window elapsed

describe("objectiveHealth", () => {
  it("is done at 100% or COMPLETED", () => {
    expect(objectiveHealth(100, target, "ACTIVE", start, now)).toBe("done");
    expect(objectiveHealth(40, target, "COMPLETED", start, now)).toBe("done");
  });

  it("has no signal without a target date", () => {
    expect(objectiveHealth(40, null, "ACTIVE", start, now)).toBe("no_date");
  });

  it("is behind when past due and not done", () => {
    expect(objectiveHealth(80, now - DAY, "ACTIVE", start, now)).toBe("behind");
  });

  it("is on_track when progress keeps up with elapsed time", () => {
    // 50% elapsed, 55% done → on track
    expect(objectiveHealth(55, target, "ACTIVE", start, now)).toBe("on_track");
    // exactly on pace
    expect(objectiveHealth(50, target, "ACTIVE", start, now)).toBe("on_track");
  });

  it("is at_risk when moderately behind pace", () => {
    // 50% elapsed, 35% done → 15 behind → at risk
    expect(objectiveHealth(35, target, "ACTIVE", start, now)).toBe("at_risk");
  });

  it("is behind when far behind pace", () => {
    // 50% elapsed, 10% done → 40 behind → behind
    expect(objectiveHealth(10, target, "ACTIVE", start, now)).toBe("behind");
  });

  it("stays on_track when there's no usable start window", () => {
    expect(objectiveHealth(5, target, "ACTIVE", null, now)).toBe("on_track");
  });
});
