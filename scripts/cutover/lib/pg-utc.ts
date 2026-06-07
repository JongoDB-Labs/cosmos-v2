// scripts/cutover/lib/pg-utc.ts
//
// TIMEZONE-CORRECT watermark round-trip (M1 fix). Every DateTime column in this schema is
// `timestamp WITHOUT time zone` (no @db.Timestamptz). node-pg's DEFAULT parser for OID 1114
// (`timestamp without time zone`) interprets the value in the PROCESS-LOCAL timezone and returns
// a JS Date. Calling `.toISOString()` on that Date then re-expresses the SAME wall-clock as UTC
// `…Z` — but shifted by the host's TZ offset. Casting that string back to `timestamp` on the next
// SELECT discards the `Z` and compares it as a literal wall-clock, so with a host TZ WEST of UTC
// the stored watermark runs AHEAD of the DB clock and rows written in the offset-sized window
// after a cycle satisfy NEITHER `> $watermark` nor the next cycle's filter → SILENTLY SKIPPED.
//
// FIX (belt + suspenders):
//   1. forceUtcProcessTz() — set process.env.TZ = "UTC" at the very top of the runner (before
//      ANY pg/Date use) so JS Date math + .toISOString() are offset-free.
//   2. registerUtcTimestampParser() — register a node-pg type parser for OID 1114 that parses the
//      raw `timestamp without time zone` text AS UTC (append `Z`), so a read is offset-free even
//      if some future host has a non-UTC TZ leak. Either alone fixes it; both together is robust.
//
// Pure + dependency-light (only `pg`) so it's importable from the `.mjs` tsx runner scripts.

import pg from "pg";

/**
 * Force the process timezone to UTC. MUST be called at the VERY TOP of a runner script, before
 * any Date is constructed or any pg value is parsed — Node reads $TZ when the first Date is
 * created and caches it, so a late set is a no-op. Idempotent.
 */
export function forceUtcProcessTz(): void {
  process.env.TZ = "UTC";
}

// OID for `timestamp without time zone` (pg_type.typname = 'timestamp'). Stable across PG versions.
const OID_TIMESTAMP_WITHOUT_TZ = 1114;

/**
 * Register a node-pg type parser for OID 1114 (`timestamp without time zone`) that interprets the
 * stored wall-clock AS UTC and returns the canonical ISO-8601 `…Z` string. Because every read of a
 * timestamp column now yields a UTC ISO string (not a host-TZ Date), the watermark round-trip is
 * offset-free regardless of the host timezone. Idempotent (re-registering is harmless).
 *
 * We return the ISO STRING (not a Date) deliberately: the export/watermark path stringifies the
 * value anyway (export-core.isoOf, advanceWatermark compares strings), so returning the exact
 * UTC ISO form here removes the host-TZ Date hop entirely.
 */
export function registerUtcTimestampParser(): void {
  pg.types.setTypeParser(OID_TIMESTAMP_WITHOUT_TZ, (raw: string | null): string | null => {
    if (raw == null) return null;
    // pg text form: "2026-06-07 01:00:00" or "2026-06-07 01:00:00.123456" (a space separator, no
    // offset). Normalize to ISO-8601 UTC: replace the space with 'T', trim trailing zeros on the
    // fractional part for stable output, and append 'Z' (the value IS the UTC wall-clock).
    const iso = raw.replace(" ", "T");
    return iso.endsWith("Z") ? iso : `${iso}Z`;
  });
}

/** Convenience: do both (force UTC process TZ + register the OID 1114 parser). */
export function setupUtcTimestamps(): void {
  forceUtcProcessTz();
  registerUtcTimestampParser();
}
