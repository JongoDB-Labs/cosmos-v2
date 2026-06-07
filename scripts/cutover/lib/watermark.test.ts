// scripts/cutover/lib/watermark.test.ts
//
// Pure unit tests for the incremental soak-sync watermark logic: the watermark-column
// derivation, the delta WHERE-clause fragment builder, the watermark advance, and the state
// validation. No DB — these are the correctness crux of "never skip a changed row".

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  watermarkColumnFor,
  deltaWhereFragment,
  advanceWatermark,
  emptyState,
  watermarksForOrg,
  assertValidState,
  type WatermarkPlan,
} from "./watermark";
import type { ModelPlan } from "./model-graph";

const mutablePlan: ModelPlan = {
  model: "WorkItem",
  table: "work_items",
  pk: ["id"],
  appendOnly: false,
  updatedAtColumn: "updated_at",
  moneyColumns: [],
  scope: { kind: "DIRECT", orgIdColumn: "org_id" },
};

const appendOnlyPlan: ModelPlan = {
  model: "ChatMessage",
  table: "chat_messages",
  pk: ["id"],
  appendOnly: true,
  updatedAtColumn: null,
  moneyColumns: [],
  scope: { kind: "PARENT" },
};

describe("watermarkColumnFor — column derivation", () => {
  it("mutable (has updated_at) ⇒ watermark = updated_at", () => {
    const wm = watermarkColumnFor(mutablePlan, true);
    expect(wm.column).toBe("updated_at");
    expect(wm.reason).toBe("updated_at");
  });

  it("append-only WITH a created_at ⇒ watermark = created_at", () => {
    const wm = watermarkColumnFor(appendOnlyPlan, true);
    expect(wm.column).toBe("created_at");
    expect(wm.reason).toBe("created_at");
  });

  it("append-only WITHOUT updated_at or created_at ⇒ no column (full-scan)", () => {
    const wm = watermarkColumnFor(appendOnlyPlan, false);
    expect(wm.column).toBeNull();
    expect(wm.reason).toBe("full-scan-no-time-column");
  });

  it("updated_at takes precedence over created_at even when both exist", () => {
    const wm = watermarkColumnFor(mutablePlan, true);
    expect(wm.column).toBe("updated_at");
  });
});

describe("deltaWhereFragment — the delta WHERE-clause builder", () => {
  const wm = watermarkColumnFor(mutablePlan, true);

  it("first sync (null last watermark) ⇒ NO filter (full org-scope seed)", () => {
    expect(deltaWhereFragment(wm, null, 2)).toEqual({ sql: null, value: undefined });
    expect(deltaWhereFragment(wm, undefined, 2)).toEqual({ sql: null, value: undefined });
    expect(deltaWhereFragment(wm, "", 2)).toEqual({ sql: null, value: undefined });
  });

  it("with a last watermark ⇒ `col > $N` and binds the last watermark", () => {
    const f = deltaWhereFragment(wm, "2026-06-01T00:00:00.000Z", 2);
    expect(f.sql).toBe('"work_items"."updated_at" > $2');
    expect(f.value).toBe("2026-06-01T00:00:00.000Z");
  });

  it("respects the placeholder index (so it can be ANDed after the org-scope $1)", () => {
    const f = deltaWhereFragment(wm, "2026-06-01T00:00:00.000Z", 5);
    expect(f.sql).toBe('"work_items"."updated_at" > $5');
  });

  it("a full-scan table (no watermark column) ⇒ NEVER a filter, even with a stale last value", () => {
    const noWm: WatermarkPlan = { table: "board_columns", model: "BoardColumn", column: null, reason: "full-scan-no-time-column" };
    expect(deltaWhereFragment(noWm, "2026-06-01T00:00:00.000Z", 2)).toEqual({ sql: null, value: undefined });
  });

  it("uses strictly-greater-than (>) — never >= — so a row never re-imports on an unchanged ceiling unless tied at max", () => {
    const f = deltaWhereFragment(wm, "2026-06-01T00:00:00.000Z", 2);
    expect(f.sql).toContain(" > ");
    expect(f.sql).not.toContain(">=");
  });
});

describe("advanceWatermark — never goes backwards, max of observed", () => {
  const wm = watermarkColumnFor(mutablePlan, true);

  it("advances to the MAX observed value when newer than prev", () => {
    const next = advanceWatermark(wm, "2026-06-01T00:00:00.000Z", [
      "2026-06-03T00:00:00.000Z",
      "2026-06-02T00:00:00.000Z",
    ]);
    expect(next).toBe("2026-06-03T00:00:00.000Z");
  });

  it("never goes backwards (keeps prev when observed are all older/equal)", () => {
    const next = advanceWatermark(wm, "2026-06-05T00:00:00.000Z", [
      "2026-06-01T00:00:00.000Z",
      "2026-06-05T00:00:00.000Z",
    ]);
    expect(next).toBe("2026-06-05T00:00:00.000Z");
  });

  it("no observed rows ⇒ watermark UNCHANGED (a cycle with nothing new keeps the watermark)", () => {
    expect(advanceWatermark(wm, "2026-06-05T00:00:00.000Z", [])).toBe("2026-06-05T00:00:00.000Z");
  });

  it("first sync (prev null) advances from null to the max observed", () => {
    const next = advanceWatermark(wm, null, [
      "2026-06-01T00:00:00.000Z",
      "2026-06-04T00:00:00.000Z",
    ]);
    expect(next).toBe("2026-06-04T00:00:00.000Z");
  });

  it("first sync with NO rows ⇒ stays null (table seeded empty, full-scan next time)", () => {
    expect(advanceWatermark(wm, null, [])).toBeNull();
  });

  it("ignores null/empty observed values (a NULL updated_at row can't lower the watermark)", () => {
    const next = advanceWatermark(wm, "2026-06-01T00:00:00.000Z", [null, "", "2026-06-02T00:00:00.000Z"]);
    expect(next).toBe("2026-06-02T00:00:00.000Z");
  });

  it("a full-scan table always advances to null (no watermark is ever kept)", () => {
    const noWm: WatermarkPlan = { table: "board_columns", model: "BoardColumn", column: null, reason: "full-scan-no-time-column" };
    expect(advanceWatermark(noWm, "anything", ["2026-06-02T00:00:00.000Z"])).toBeNull();
  });

  it("ISO-8601 strings compare chronologically (lexical == chronological in UTC Z form)", () => {
    // 09:00 vs 10:00 — lexical compare must pick 10:00 as the max.
    const next = advanceWatermark(wm, null, ["2026-06-01T09:00:00.000Z", "2026-06-01T10:00:00.000Z"]);
    expect(next).toBe("2026-06-01T10:00:00.000Z");
  });
});

describe("M1 — compare/advance is STABLE under a non-UTC process.env.TZ (no boundary skip)", () => {
  const wm = watermarkColumnFor(mutablePlan, true);
  let savedTz: string | undefined;
  beforeEach(() => {
    savedTz = process.env.TZ;
  });
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it("advance + the next-cycle `> $last` boundary are identical under UTC and America/New_York", () => {
    // The watermark values are ALWAYS UTC ISO `…Z` (the OID-1114 parser guarantees that — see
    // pg-utc.test.ts). advanceWatermark/deltaWhereFragment are pure string ops, so they must NOT
    // depend on the host TZ. Run the same inputs under a west TZ and under UTC and compare.
    const observed = ["2026-06-07T01:00:00Z", "2026-06-07T00:30:00Z"];

    process.env.TZ = "America/New_York";
    const advWest = advanceWatermark(wm, "2026-06-06T00:00:00Z", observed);
    const fragWest = deltaWhereFragment(wm, advWest, 2);

    process.env.TZ = "UTC";
    const advUtc = advanceWatermark(wm, "2026-06-06T00:00:00Z", observed);
    const fragUtc = deltaWhereFragment(wm, advUtc, 2);

    expect(advWest).toBe("2026-06-07T01:00:00Z");
    expect(advWest).toBe(advUtc); // host TZ does not move the watermark
    expect(fragWest).toEqual(fragUtc);
    expect(fragWest.value).toBe("2026-06-07T01:00:00Z");
  });

  it("a row at the offset-sized boundary is INCLUDED by the next cycle (the bug it fixes)", () => {
    process.env.TZ = "America/New_York"; // WEST of UTC — the original silently-skip condition
    // Last watermark (UTC ISO, offset-free). A row written 1 minute later must be `> $last`.
    const last = advanceWatermark(wm, null, ["2026-06-07T01:00:00Z"]);
    const frag = deltaWhereFragment(wm, last, 2);
    // The boundary row's UTC ISO compares strictly greater (lexical == chronological in Z form).
    expect("2026-06-07T01:01:00Z" > String(frag.value)).toBe(true); // caught, never skipped
  });
});

describe("soak state — shape + helpers + validation", () => {
  it("emptyState is a valid v1 doc with no orgs", () => {
    const s = emptyState();
    expect(s.kind).toBe("cosmos-soak-sync-state");
    expect(s.version).toBe(1);
    expect(s.orgs).toEqual({});
    expect(() => assertValidState(s)).not.toThrow();
  });

  it("watermarksForOrg returns {} for an unknown org (⇒ full first sync)", () => {
    expect(watermarksForOrg(emptyState(), "org-x")).toEqual({});
  });

  it("watermarksForOrg returns the stored per-table map", () => {
    const s = emptyState();
    s.orgs["org-1"] = { work_items: "2026-06-01T00:00:00.000Z", board_columns: null };
    expect(watermarksForOrg(s, "org-1")).toEqual({
      work_items: "2026-06-01T00:00:00.000Z",
      board_columns: null,
    });
  });

  it("assertValidState rejects a malformed doc (fail-closed — a corrupt state could skip rows)", () => {
    expect(() => assertValidState({})).toThrow(/valid cosmos-soak-sync-state/);
    expect(() => assertValidState({ kind: "wrong", version: 1, orgs: {} })).toThrow();
    expect(() => assertValidState({ kind: "cosmos-soak-sync-state", version: 2, orgs: {} })).toThrow();
    expect(() => assertValidState(null)).toThrow();
  });
});
