import { describe, it, expect } from "vitest";
import { pendingGated } from "./reconcile";
import type { LedgerEntry, Resolution } from "./ledger";

const entry = (ticket: string, resolution: Resolution, ts: string): LedgerEntry => ({
  ticket,
  title: ticket,
  classification: "BUG",
  resolution,
  ts,
});

describe("pendingGated", () => {
  it("returns only refs whose LAST entry is gated — distinct + order-stable", () => {
    const entries: LedgerEntry[] = [
      entry("COSMOS-1", "gated", "2026-07-01T00:00:00Z"), // gated-then-shipped → NOT pending
      entry("COSMOS-1", "shipped", "2026-07-02T00:00:00Z"),
      entry("COSMOS-2", "gated", "2026-07-01T00:00:00Z"), // gated-only → pending
      entry("COSMOS-3", "gated", "2026-07-01T00:00:00Z"), // gated-then-gated-again → pending
      entry("COSMOS-3", "gated", "2026-07-03T00:00:00Z"),
      entry("COSMOS-4", "shipped", "2026-07-01T00:00:00Z"), // never-gated → not pending
    ];
    expect(pendingGated(entries)).toEqual(["COSMOS-2", "COSMOS-3"]);
  });

  it("returns [] for no entries", () => {
    expect(pendingGated([])).toEqual([]);
  });

  it("treats a later terminal outcome (duplicate / already-done) as clearing the gate", () => {
    const entries: LedgerEntry[] = [
      entry("COSMOS-5", "gated", "2026-07-01T00:00:00Z"),
      entry("COSMOS-5", "duplicate", "2026-07-02T00:00:00Z"),
      entry("COSMOS-6", "gated", "2026-07-01T00:00:00Z"),
      entry("COSMOS-6", "already-done", "2026-07-02T00:00:00Z"),
    ];
    expect(pendingGated(entries)).toEqual([]);
  });

  it("treats a later needs-input as clearing the gate — needs-input-last is not pending", () => {
    const entries: LedgerEntry[] = [
      entry("COSMOS-8", "gated", "2026-07-01T00:00:00Z"),
      entry("COSMOS-8", "needs-input", "2026-07-02T00:00:00Z"),
    ];
    expect(pendingGated(entries)).toEqual([]);
  });

  it("preserves first-appearance order across interleaved tickets", () => {
    const entries: LedgerEntry[] = [
      entry("COSMOS-9", "gated", "2026-07-01T00:00:00Z"),
      entry("COSMOS-7", "gated", "2026-07-01T00:00:00Z"),
      entry("COSMOS-9", "gated", "2026-07-02T00:00:00Z"),
    ];
    expect(pendingGated(entries)).toEqual(["COSMOS-9", "COSMOS-7"]);
  });
});
