import { describe, it, expect } from "vitest";
import { FEATURE_OPTIONS, isOfferedTo, isRetiredFeature } from "./project-features";

describe("which modules a project's settings offer", () => {
  it("offers a live module to every project", () => {
    expect(isOfferedTo("roadmap", [])).toBe(true);
  });

  it("does not offer a retired module to a project that never ran the PM suite", () => {
    expect(isOfferedTo("program-calendar", ["roadmap"])).toBe(false);
    expect(isOfferedTo("pm-dashboard", [])).toBe(false);
  });

  it("keeps a retired module a project had when the screen loaded, so a misclick can be undone", () => {
    expect(isOfferedTo("risk-register", ["risk-register"])).toBe(true);
  });

  it("offers the whole PM suite to a project still running the PM Dashboard", () => {
    // Four prod projects run it without the calendar; retiring the keys must not
    // stop them adding a register until Program Management replaces the suite.
    const held = ["pm-dashboard", "risk-register"];
    expect(isOfferedTo("program-calendar", held)).toBe(true);
    expect(isOfferedTo("clin-burn", held)).toBe(true);
  });

  it("retires exactly the PM suite (the rule above assumes it)", () => {
    // Retiring anything else needs its own offer rule, not this one.
    const retired = FEATURE_OPTIONS.map((f) => f.key).filter(isRetiredFeature).sort();
    expect(retired).toEqual(
      [
        "blocked-items", "change-log", "clin-burn", "deliverables-tracker", "pm-dashboard",
        "program-calendar", "risk-register", "schedule-variance", "staffing", "vendors",
      ],
    );
  });
});
