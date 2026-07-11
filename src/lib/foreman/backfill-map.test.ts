import { describe, expect, it } from "vitest";
import { mapLedgerEntry } from "../../../scripts/foreman/backfill-events.mjs";

describe("mapLedgerEntry", () => {
  it("maps shipped with version", () => {
    const m = mapLedgerEntry({ ticket: "COSMOS-1", title: "t", classification: "BUG", resolution: "shipped", version: "2.160.5", ts: "2026-07-09T00:00:00.000Z" });
    expect(m).toMatchObject({ ticketKey: "COSMOS-1", kind: "shipped", severity: "info", data: { version: "2.160.5", backfilled: true } });
    expect(m.ts.toISOString()).toBe("2026-07-09T00:00:00.000Z");
  });
  it("maps gated as warn and duplicate with dupOf", () => {
    expect(mapLedgerEntry({ ticket: "A-1", title: "t", classification: "BUG", resolution: "gated", ts: "2026-07-09T00:00:00.000Z" }).severity).toBe("warn");
    expect(mapLedgerEntry({ ticket: "A-2", title: "t", classification: "BUG", resolution: "duplicate", dupOf: "A-1", ts: "2026-07-09T00:00:00.000Z" }).data.dupOf).toBe("A-1");
  });
});
