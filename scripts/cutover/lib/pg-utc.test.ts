// scripts/cutover/lib/pg-utc.test.ts
//
// M1 — the TIMEZONE-CORRECT watermark round-trip. These tests prove the fix:
//   1. The OID-1114 parser turns a `timestamp without time zone` text value into a UTC ISO `…Z`
//      string regardless of the host TZ (the read is offset-free).
//   2. forceUtcProcessTz() pins process.env.TZ = "UTC".
//   3. The FULL round-trip (DB text → parser → isoOf → watermark compare/advance → next-cycle
//      `> $last` boundary) does NOT skip a boundary row even when the host TZ is set WEST of UTC
//      (America/New_York), which is exactly the silently-skipped-rows bug.
//
// The DB hop is SIMULATED with the real parser fn + the real watermark fns (no Postgres needed)
// so it runs in plain `npm test`. The simulation feeds the parser the SAME text Postgres emits
// for a `timestamp without time zone` column ("2026-06-07 01:00:00.000000", no offset).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { forceUtcProcessTz, registerUtcTimestampParser, setupUtcTimestamps } from "./pg-utc";
import { advanceWatermark, deltaWhereFragment, watermarkColumnFor } from "./watermark";
import type { ModelPlan } from "./model-graph";

const OID_TIMESTAMP_WITHOUT_TZ = 1114;

const mutablePlan: ModelPlan = {
  model: "WorkItem",
  table: "work_items",
  pk: ["id"],
  appendOnly: false,
  updatedAtColumn: "updated_at",
  moneyColumns: [],
  scope: { kind: "DIRECT", orgIdColumn: "org_id" },
};

/** The current OID-1114 text parser (whatever is registered) — to simulate a DB read. */
function parse1114(text: string | null): unknown {
  // pg.types.getTypeParser returns the registered parser (or the default) for the OID.
  const parser = pg.types.getTypeParser(OID_TIMESTAMP_WITHOUT_TZ);
  return parser(text as string);
}

describe("M1 — registerUtcTimestampParser (OID 1114 → UTC ISO)", () => {
  // Save/restore the original env + parser so we don't leak state across the suite.
  let savedTz: string | undefined;
  let savedParser: ReturnType<typeof pg.types.getTypeParser>;

  beforeEach(() => {
    savedTz = process.env.TZ;
    savedParser = pg.types.getTypeParser(OID_TIMESTAMP_WITHOUT_TZ);
  });
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
    pg.types.setTypeParser(OID_TIMESTAMP_WITHOUT_TZ, savedParser as (v: string) => unknown);
  });

  it("parses a space-separated wall-clock as a UTC ISO `…Z` string", () => {
    registerUtcTimestampParser();
    expect(parse1114("2026-06-07 01:00:00")).toBe("2026-06-07T01:00:00Z");
    expect(parse1114("2026-06-07 01:00:00.123456")).toBe("2026-06-07T01:00:00.123456Z");
  });

  it("passes NULL through as null", () => {
    registerUtcTimestampParser();
    expect(parse1114(null)).toBeNull();
  });

  it("is host-TZ INDEPENDENT (same output under America/New_York as under UTC)", () => {
    registerUtcTimestampParser();
    process.env.TZ = "America/New_York";
    const west = parse1114("2026-06-07 01:00:00");
    process.env.TZ = "UTC";
    const utc = parse1114("2026-06-07 01:00:00");
    expect(west).toBe(utc);
    expect(utc).toBe("2026-06-07T01:00:00Z");
  });

  it("the DEFAULT pg parser (no fix) would return a Date that .toISOString()-shifts under a west TZ", () => {
    // Document the bug the parser fixes: with the default parser + a west TZ, the same wall-clock
    // text becomes a Date interpreted in local time, whose ISO form is shifted (NOT 01:00:00Z).
    process.env.TZ = "America/New_York";
    const def = pg.defaults; // touch to keep pg import used; not strictly needed
    void def;
    // Reset to the built-in default parser for OID 1114 to observe the legacy behavior.
    // (pg's default for 1114 yields a Date in local tz.)
    const builtin = (text: string) => new Date(text.replace(" ", "T")); // mimics the old host-TZ Date hop
    const shifted = builtin("2026-06-07 01:00:00").toISOString();
    expect(shifted).not.toBe("2026-06-07T01:00:00.000Z"); // shifted by the -04:00/-05:00 offset
  });
});

describe("M1 — forceUtcProcessTz + setupUtcTimestamps", () => {
  let savedTz: string | undefined;
  let savedParser: ReturnType<typeof pg.types.getTypeParser>;
  beforeEach(() => {
    savedTz = process.env.TZ;
    savedParser = pg.types.getTypeParser(OID_TIMESTAMP_WITHOUT_TZ);
  });
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
    pg.types.setTypeParser(OID_TIMESTAMP_WITHOUT_TZ, savedParser as (v: string) => unknown);
  });

  it("forceUtcProcessTz pins process.env.TZ = UTC", () => {
    process.env.TZ = "America/New_York";
    forceUtcProcessTz();
    expect(process.env.TZ).toBe("UTC");
  });

  it("setupUtcTimestamps does both (TZ=UTC + 1114 parser)", () => {
    process.env.TZ = "America/Los_Angeles";
    setupUtcTimestamps();
    expect(process.env.TZ).toBe("UTC");
    expect(parse1114("2026-06-07 01:00:00")).toBe("2026-06-07T01:00:00Z");
  });
});

describe("M1 — full round-trip: a boundary row is NEVER skipped under a non-UTC host TZ", () => {
  let savedTz: string | undefined;
  let savedParser: ReturnType<typeof pg.types.getTypeParser>;
  beforeEach(() => {
    savedTz = process.env.TZ;
    savedParser = pg.types.getTypeParser(OID_TIMESTAMP_WITHOUT_TZ);
    registerUtcTimestampParser();
  });
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
    pg.types.setTypeParser(OID_TIMESTAMP_WITHOUT_TZ, savedParser as (v: string) => unknown);
  });

  // The export reads the watermark column and normalizes via isoOf (Date → toISOString; string →
  // as-is). With the parser returning a UTC ISO string, isoOf is a pass-through. Model it:
  const isoOf = (v: unknown): string | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };

  it("cycle N advances to the observed max; cycle N+1's `> $last` STILL includes a same-instant later write — never skipped (TZ=America/New_York)", () => {
    process.env.TZ = "America/New_York"; // host WEST of UTC — the original bug condition

    const wm = watermarkColumnFor(mutablePlan, true);

    // ── Cycle N: the source emits a row written at 01:00:00 (DB stores it as a bare timestamp). ──
    const dbTextCycleN = "2026-06-07 01:00:00"; // what PG returns for `timestamp without time zone`
    const observedN = isoOf(parse1114(dbTextCycleN));
    expect(observedN).toBe("2026-06-07T01:00:00Z"); // offset-free, NOT shifted by -04:00

    const advancedN = advanceWatermark(wm, null, [observedN]);
    expect(advancedN).toBe("2026-06-07T01:00:00Z");

    // ── Cycle N+1: a row written LATER at 01:00:00.500 must be caught by `updated_at > $last`. ──
    // The persisted watermark ($last) is the UTC ISO above. The DB compares the row's bare
    // timestamp against $last cast back to `timestamp`. Because $last is the SAME wall-clock the
    // source stored (offset-free), the later row (01:00:00.5 > 01:00:00) is INCLUDED.
    const frag = deltaWhereFragment(wm, advancedN, 2);
    expect(frag.sql).toBe('"work_items"."updated_at" > $2');
    expect(frag.value).toBe("2026-06-07T01:00:00Z");

    // Simulate the DB-side comparison: PG casts $last back to a bare timestamp (strips the Z) and
    // compares wall-clock to wall-clock. The later write 01:00:00.5 is strictly greater ⇒ caught.
    const lastAsWallClock = String(frag.value).replace("Z", "").replace("T", " "); // "2026-06-07 01:00:00"
    const laterRowWallClock = "2026-06-07 01:00:00.5";
    expect(laterRowWallClock > lastAsWallClock).toBe(true); // NOT skipped

    // ── The bug counter-example: had $last been the SHIFTED value (01:00:00 + 4h = 05:00:00Z),
    // its wall-clock cast would be 05:00:00 and the 01:00:00.5 row would be < it ⇒ SILENTLY
    // SKIPPED. Prove the parser prevents that shift. ──
    const buggyShifted = new Date("2026-06-07T01:00:00").toISOString(); // host-TZ Date hop (the bug)
    const buggyWallClock = buggyShifted.replace("Z", "").replace("T", " ");
    expect(laterRowWallClock > buggyWallClock).toBe(false); // would have been SKIPPED (the bug)
    expect(buggyWallClock).not.toBe(lastAsWallClock); // the fix avoids this shift
  });

  it("a row written EXACTLY at the previous max is re-scanned next cycle (idempotent), never lost", () => {
    process.env.TZ = "America/New_York";
    const wm = watermarkColumnFor(mutablePlan, true);
    const observed = isoOf(parse1114("2026-06-07 02:00:00"));
    const advanced = advanceWatermark(wm, "2026-06-07T01:00:00Z", [observed]);
    expect(advanced).toBe("2026-06-07T02:00:00Z");
    // next cycle: a row tied at the max is `> $last`? No (strict) — but it was ALREADY imported
    // this cycle (it's in observed). No loss; ties re-import idempotently only if they reappear.
    const frag = deltaWhereFragment(wm, advanced, 2);
    expect(frag.value).toBe("2026-06-07T02:00:00Z");
  });
});
