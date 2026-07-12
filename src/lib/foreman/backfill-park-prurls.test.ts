import { describe, it, expect } from "vitest";
import { decidePrBackfill, latestParkNeedingPr, type ParkEventInput } from "./backfill-park-prurls";

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

  // FIX 1: the backfill must patch the SAME event the console's Approve gate reads.
  // status-read.ts surfaces the newest park carrying `data.reason`, falling back to
  // the newest-of-any only when none is reasoned. When the daemon writes a later
  // reason-less `gated` event (run.mts, on repeated failure) after an earlier
  // reasoned `parked`, the console keeps showing the older reasoned one — so the
  // patch must land there, not on the newer blank event.
  it("selects the OLDER reasoned park, not a NEWER reason-less event (matches the console's Approve gate)", () => {
    const events = [
      // ts-desc, as the DB query returns them.
      ev({ id: "gated-newer", kind: "gated", ts: "2026-01-02T00:00:00Z", data: {} }),
      ev({ id: "parked-older", kind: "parked", ts: "2026-01-01T00:00:00Z", data: { reason: "checks failed" } }),
    ];
    expect(latestParkNeedingPr(events)).toEqual({ id: "parked-older", data: { reason: "checks failed" } });
  });

  it("selects the OLDER reasoned park even when the newer reason-less event has undefined data", () => {
    const events = [
      ev({ id: "gated-newer", kind: "gated", ts: "2026-01-02T00:00:00Z", data: undefined }),
      ev({ id: "parked-older", kind: "parked", ts: "2026-01-01T00:00:00Z", data: { reason: "risk gate" } }),
    ];
    expect(latestParkNeedingPr(events)).toEqual({ id: "parked-older", data: { reason: "risk gate" } });
  });

  it("prefers the NEWEST reasoned park when more than one event carries a reason", () => {
    const events = [
      ev({ id: "parked-newer", kind: "parked", ts: "2026-01-03T00:00:00Z", data: { reason: "newest" } }),
      ev({ id: "gated-older", kind: "gated", ts: "2026-01-01T00:00:00Z", data: { reason: "oldest" } }),
    ];
    expect(latestParkNeedingPr(events)).toEqual({ id: "parked-newer", data: { reason: "newest" } });
  });

  it("falls back to the newest park of any kind when NO event carries a reason", () => {
    const events = [
      ev({ id: "gated-newer", kind: "gated", ts: "2026-01-02T00:00:00Z", data: { branch: "auto/X-1" } }),
      ev({ id: "parked-older", kind: "parked", ts: "2026-01-01T00:00:00Z", data: {} }),
    ];
    expect(latestParkNeedingPr(events)).toEqual({ id: "gated-newer", data: { branch: "auto/X-1" } });
  });

  // FIX 4: exact-ms ts ties break by id descending, mirroring the events query's
  // secondary `orderBy: [{ ts: "desc" }, { id: "desc" }]`, so a re-run is stable.
  it("breaks an exact-ts tie by id descending (mirrors the query's secondary order)", () => {
    const events = [
      ev({ id: "aaa", kind: "parked", ts: "2026-01-01T00:00:00Z", data: { reason: "a" } }),
      ev({ id: "zzz", kind: "gated", ts: "2026-01-01T00:00:00Z", data: { reason: "z" } }),
    ];
    expect(latestParkNeedingPr(events)).toEqual({ id: "zzz", data: { reason: "z" } });
  });
});

describe("decidePrBackfill", () => {
  const url = "https://github.com/org/repo/pull/7";

  it("patches an OPEN PR", () => {
    expect(decidePrBackfill({ url, state: "OPEN" })).toEqual({ kind: "patch", url, state: "OPEN" });
  });

  it("patches a MERGED PR", () => {
    expect(decidePrBackfill({ url, state: "MERGED" })).toEqual({ kind: "patch", url, state: "MERGED" });
  });

  it("skips a PR CLOSED without merge", () => {
    expect(decidePrBackfill({ url, state: "CLOSED" })).toEqual({ kind: "closed" });
  });

  it("matches state case-insensitively", () => {
    expect(decidePrBackfill({ url, state: "open" })).toEqual({ kind: "patch", url, state: "OPEN" });
  });

  it("trims a surrounding-whitespace url before patching", () => {
    expect(decidePrBackfill({ url: `  ${url}  `, state: "OPEN" })).toEqual({ kind: "patch", url, state: "OPEN" });
  });

  it("fails closed on an unknown state (never lights Approve)", () => {
    expect(decidePrBackfill({ url, state: "DRAFT" })).toEqual({ kind: "closed" });
  });

  it("reports no-url for a null, undefined, empty, or blank url", () => {
    expect(decidePrBackfill({ url: null, state: "OPEN" })).toEqual({ kind: "no-url" });
    expect(decidePrBackfill({ url: undefined, state: "OPEN" })).toEqual({ kind: "no-url" });
    expect(decidePrBackfill({ url: "", state: "OPEN" })).toEqual({ kind: "no-url" });
    expect(decidePrBackfill({ url: "   ", state: "OPEN" })).toEqual({ kind: "no-url" });
  });

  it("reports no-url even when state is empty/null (no PR resolved)", () => {
    expect(decidePrBackfill({ url: null, state: null })).toEqual({ kind: "no-url" });
  });
});
