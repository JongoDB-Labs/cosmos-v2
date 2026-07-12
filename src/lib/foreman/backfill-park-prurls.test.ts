import { describe, it, expect } from "vitest";
import { latestParkNeedingPr, type ParkEventInput } from "./backfill-park-prurls";

const ev = (over: Omit<Partial<ParkEventInput>, "ts"> & { id: string; ts: string }): ParkEventInput => ({
  kind: "parked",
  data: {},
  ...over,
  ts: new Date(over.ts),
});

describe("latestParkNeedingPr", () => {
  it("returns null for an empty event list", () => {
    expect(latestParkNeedingPr([])).toBeNull();
  });

  it("returns null when no event is a parked kind", () => {
    const events = [
      ev({ id: "e1", kind: "shipped", ts: "2026-01-01T00:00:00Z" }),
      ev({ id: "e2", kind: "claimed", ts: "2026-01-02T00:00:00Z" }),
      ev({ id: "e3", kind: "planned", ts: "2026-01-03T00:00:00Z" }),
    ];
    expect(latestParkNeedingPr(events)).toBeNull();
  });

  it("picks the latest parked-kind event by ts, ignoring an older park and a non-park kind in between", () => {
    const events = [
      ev({ id: "old-park", kind: "parked", ts: "2026-01-01T00:00:00Z", data: { reason: "old" } }),
      ev({ id: "shipped-between", kind: "shipped", ts: "2026-01-02T00:00:00Z" }),
      ev({ id: "new-park", kind: "gated", ts: "2026-01-03T00:00:00Z", data: { reason: "new" } }),
    ];
    expect(latestParkNeedingPr(events)).toEqual({ id: "new-park", data: { reason: "new" } });
  });

  it("recognizes every PARKED_EVENT_KINDS member, not just 'parked'", () => {
    for (const kind of ["parked", "gated", "needs-input", "ship-failed", "merged-undeployed"]) {
      const events = [ev({ id: `e-${kind}`, kind, ts: "2026-01-01T00:00:00Z" })];
      expect(latestParkNeedingPr(events)).toEqual({ id: `e-${kind}`, data: {} });
    }
  });

  it("skips (returns null) when the latest park already has a non-empty prUrl", () => {
    const events = [
      ev({ id: "e1", kind: "parked", ts: "2026-01-01T00:00:00Z" }),
      ev({ id: "e2", kind: "ship-failed", ts: "2026-01-02T00:00:00Z", data: { prUrl: "https://github.com/org/repo/pull/1" } }),
    ];
    expect(latestParkNeedingPr(events)).toBeNull();
  });

  it("does not skip when an OLDER park has a prUrl but the latest one doesn't", () => {
    const events = [
      ev({ id: "e1", kind: "parked", ts: "2026-01-01T00:00:00Z", data: { prUrl: "https://github.com/org/repo/pull/1" } }),
      ev({ id: "e2", kind: "gated", ts: "2026-01-02T00:00:00Z", data: {} }),
    ];
    expect(latestParkNeedingPr(events)).toEqual({ id: "e2", data: {} });
  });

  it("does not skip when the latest park's prUrl is an empty string", () => {
    const events = [ev({ id: "e1", kind: "parked", ts: "2026-01-01T00:00:00Z", data: { prUrl: "" } })];
    expect(latestParkNeedingPr(events)).toEqual({ id: "e1", data: { prUrl: "" } });
  });

  it("treats a non-string prUrl as absent and still returns the event", () => {
    const events = [ev({ id: "e1", kind: "merged-undeployed", ts: "2026-01-01T00:00:00Z", data: { prUrl: 12345 } })];
    expect(latestParkNeedingPr(events)).toEqual({ id: "e1", data: { prUrl: 12345 } });
  });

  it("tolerates null data", () => {
    const events = [ev({ id: "e1", kind: "parked", ts: "2026-01-01T00:00:00Z", data: null })];
    expect(latestParkNeedingPr(events)).toEqual({ id: "e1", data: {} });
  });

  it("tolerates string data", () => {
    const events = [ev({ id: "e1", kind: "needs-input", ts: "2026-01-01T00:00:00Z", data: "not an object" })];
    expect(latestParkNeedingPr(events)).toEqual({ id: "e1", data: {} });
  });

  it("tolerates array data", () => {
    const events = [ev({ id: "e1", kind: "gated", ts: "2026-01-01T00:00:00Z", data: ["a", "b"] })];
    expect(latestParkNeedingPr(events)).toEqual({ id: "e1", data: {} });
  });

  it("tolerates undefined data", () => {
    const events = [ev({ id: "e1", kind: "parked", ts: "2026-01-01T00:00:00Z", data: undefined })];
    expect(latestParkNeedingPr(events)).toEqual({ id: "e1", data: {} });
  });
});
