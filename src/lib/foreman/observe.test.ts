import { describe, expect, it } from "vitest";
import { pulseFor, ALIVE_MS, STALE_MS, LEDGER_KIND_MAP } from "./observe";

const base = { paused: false, breakerTripped: false, stopFileSeen: false };
const now = new Date("2026-07-11T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("pulseFor", () => {
  it("alive under 2 min", () =>
    expect(pulseFor({ ...base, lastPassAt: ago(ALIVE_MS - 1000), now })).toBe("alive"));
  it("idle between 2 and 10 min", () =>
    expect(pulseFor({ ...base, lastPassAt: ago(ALIVE_MS + 1000), now })).toBe("idle"));
  it("stale at/after 10 min", () =>
    expect(pulseFor({ ...base, lastPassAt: ago(STALE_MS), now })).toBe("stale"));
  it("stale when never seen", () =>
    expect(pulseFor({ ...base, lastPassAt: null, now })).toBe("stale"));
  it("paused wins over everything", () =>
    expect(pulseFor({ ...base, paused: true, lastPassAt: ago(STALE_MS * 2), now })).toBe("paused"));
  it("breaker beats staleness (tripped)", () =>
    expect(pulseFor({ ...base, breakerTripped: true, lastPassAt: ago(1000), now })).toBe("breaker"));
  it("stop file reads as breaker", () =>
    expect(pulseFor({ ...base, stopFileSeen: true, lastPassAt: ago(1000), now })).toBe("breaker"));
  it("accepts ISO strings", () =>
    expect(pulseFor({ ...base, lastPassAt: ago(1000).toISOString(), now })).toBe("alive"));
});

describe("LEDGER_KIND_MAP", () => {
  it("covers every ledger resolution", () =>
    expect(Object.keys(LEDGER_KIND_MAP).sort()).toEqual(
      ["already-done", "duplicate", "gated", "needs-input", "shipped"].sort(),
    ));
});
