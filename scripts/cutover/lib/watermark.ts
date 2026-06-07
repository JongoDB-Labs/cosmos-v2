// scripts/cutover/lib/watermark.ts
//
// WATERMARK derivation + delta WHERE-clause + state advance for the incremental
// soak-sync (design spec §9.4 "soak sync = per-model idempotent replay", extended for
// an incremental catch-up by a per-table watermark).
//
// The soak-sync re-exports/re-imports ONLY the rows that changed since the last cycle,
// selected by a per-table WATERMARK column:
//   - MUTABLE tables (have `updated_at`)        ⇒ watermark = updated_at  (max updated_at)
//   - APPEND-ONLY tables WITH a created_at       ⇒ watermark = created_at  (max created_at)
//   - tables with NEITHER updated_at nor created_at ⇒ NO watermark column ⇒ FULL SCAN every
//     cycle. There are ~11 such tables (join/config children: board_columns, project_members,
//     meeting_attendees, journal_lines, …). They have no time anchor to filter on, so the
//     correctness-safe choice is to ALWAYS re-export them in full — the import is an
//     idempotent UPSERT, so a full re-scan is a cheap no-op when nothing changed, and it can
//     NEVER miss a change. (Filtering them on a guessed column would risk silently dropping
//     an update — unacceptable for a data migration.)
//
// IMPORTANT CORRECTNESS NOTES on the watermark choice:
//   - We use `>` (strictly greater) against the LAST watermark, and we ADVANCE the watermark
//     to the MAX value actually OBSERVED in the exported rows (not "now"). Using observed-max
//     (vs a wall clock) means we never skip a row whose timestamp is <= a clock we picked but
//     that was written slightly later — there is no clock-skew window. The cost is that rows
//     sharing the exact max timestamp are re-scanned next cycle (they UPSERT idempotently),
//     which is correct-by-construction (no loss) and cheap.
//   - TIMEZONE CORRECTNESS (the watermark round-trip is UTC-normalized): every DateTime column
//     in this schema is `timestamp WITHOUT time zone`. The watermark round-trip MUST be offset-
//     free or it would shift by the host's TZ offset and silently skip the rows written in the
//     offset-sized window after a cycle. Both runner scripts (soak-sync.mjs, reconcile-org.mjs)
//     force `process.env.TZ = "UTC"` at the very top (before any pg/Date use) AND register a
//     node-pg type parser for OID 1114 (`timestamp without time zone`) that appends a `Z` so the
//     value parses as UTC regardless of host TZ — belt and suspenders. So a value read from the
//     DB, ISO-stringified, compared against `$last`, and cast back to `timestamp` on the next
//     SELECT is interpreted as the SAME wall-clock instant the source stored. There is no
//     clock-skew window AND no TZ-offset window — the delta can never miss a change.
//   - created_at watermarks assume created_at is immutable (true in this schema: created_at is
//     set once at insert and never updated). An append-only row never changes after insert, so
//     `created_at > last` catches every NEW row exactly once it appears.
//   - DELETES are invisible to a watermark delta (a deleted row simply stops appearing). That
//     is BY DESIGN — soak-sync is insert/update catch-up only; the FINAL reconcile (under
//     freeze) is what removes deleted rows. See reconcile-org.mjs.
//
// Pure + dependency-light (imports only the model-graph types) so it is unit-testable with no
// DB and importable from the `.mjs` tsx scripts.

import type { ModelPlan } from "./model-graph";
import { quoteIdent } from "./model-graph";

/** The watermark plan for one table: which column anchors the delta, or null = full scan. */
export interface WatermarkPlan {
  table: string;
  model: string;
  /** The watermark column (`updated_at` | `created_at`) or null when the table has neither. */
  column: string | null;
  /** Why this column (for the report / runbook). */
  reason: "updated_at" | "created_at" | "full-scan-no-time-column";
}

/**
 * Derive the watermark column for a model plan:
 *   updated_at (mutable) → created_at (append-only with a created_at) → null (full scan).
 * The `createdAtPresent` flag must be supplied by the caller from the live/DMMF column set —
 * the ModelPlan itself only records updatedAtColumn, so we take created-at presence as input
 * to keep this pure (no DMMF coupling here).
 */
export function watermarkColumnFor(
  plan: ModelPlan,
  createdAtPresent: boolean,
): WatermarkPlan {
  if (plan.updatedAtColumn) {
    return { table: plan.table, model: plan.model, column: plan.updatedAtColumn, reason: "updated_at" };
  }
  if (createdAtPresent) {
    return { table: plan.table, model: plan.model, column: "created_at", reason: "created_at" };
  }
  return { table: plan.table, model: plan.model, column: null, reason: "full-scan-no-time-column" };
}

/**
 * Build the DELTA filter SQL fragment + the bind value for one table, given the last
 * watermark for that table (from the state file). Returns:
 *   - sql:   a SQL boolean fragment to AND into the scoped WHERE, e.g.
 *            `"work_items"."updated_at" > $N`  (the caller supplies the $N index + value)
 *            For a full-scan table (no watermark column) OR a first sync (no last watermark),
 *            sql is `null` ⇒ the caller adds NO extra filter (export the full org-scope).
 *   - value: the bind value (the last watermark) when sql is non-null, else undefined.
 *
 * The placeholder index is parameterized by `placeholderIndex` (1-based) so the caller can
 * splice it after the org-scope param ($1).
 *
 * `tableAlias` is the quoted table reference the scoped SELECT uses for THIS table's columns
 * (the exporter scopes via the table name itself, even for PARENT joins the watermark column
 * lives on the CHILD table — so we qualify with the child table name).
 */
export function deltaWhereFragment(
  wm: WatermarkPlan,
  lastWatermark: string | null | undefined,
  placeholderIndex: number,
): { sql: string | null; value: string | undefined } {
  // No watermark column → always full scan (no extra filter).
  if (wm.column === null) return { sql: null, value: undefined };
  // First sync (no recorded watermark) → full scan to seed the table.
  if (lastWatermark === null || lastWatermark === undefined || lastWatermark === "") {
    return { sql: null, value: undefined };
  }
  const col = `${quoteIdent(wm.table)}.${quoteIdent(wm.column)}`;
  return { sql: `${col} > $${placeholderIndex}`, value: lastWatermark };
}

/**
 * Advance a table's watermark given the watermark values OBSERVED in the rows just exported.
 * Returns the new watermark = max(prev, max(observed)). Comparison is on the ISO-8601 / numeric
 * string form (timestamps are exported as ISO strings, which sort lexicographically in UTC; the
 * exporter always uses ISO-8601 with a trailing Z, so lexical order == chronological order).
 *
 *   - If no rows were observed, the watermark is UNCHANGED (prev).
 *   - If the table has no watermark column, the returned watermark is always null (full scan
 *     forever — there is nothing to advance).
 *   - Never goes backwards (max with prev) so a re-ordered/partial export can't lower it.
 */
export function advanceWatermark(
  wm: WatermarkPlan,
  prev: string | null | undefined,
  observed: (string | null | undefined)[],
): string | null {
  if (wm.column === null) return null; // full-scan table: no watermark to keep
  let max: string | null = prev != null && prev !== "" ? prev : null;
  for (const v of observed) {
    if (v == null || v === "") continue;
    const s = String(v);
    if (max === null || s > max) max = s;
  }
  return max;
}

// ── State file shape (build-only; a tiny JSON keyed by orgId → per-table watermark) ──
//
// The state file is the soak-sync's only persisted memory. It is keyed by orgId so one file
// can hold many tenants, and per-table so each table advances independently. A MISSING table
// entry (or a missing file) means "no watermark yet" ⇒ a full first sync of that table.

export interface SoakState {
  kind: "cosmos-soak-sync-state";
  version: 1;
  /** orgId → { tableName → lastWatermark (ISO string) | null }. null = full-scan table. */
  orgs: Record<string, Record<string, string | null>>;
}

/** A fresh, empty state (used when --state points at a non-existent file = first sync). */
export function emptyState(): SoakState {
  return { kind: "cosmos-soak-sync-state", version: 1, orgs: {} };
}

/** Read the per-table watermark map for one org from a (possibly empty) state. */
export function watermarksForOrg(state: SoakState, orgId: string): Record<string, string | null> {
  return state.orgs[orgId] ?? {};
}

/** Validate a parsed state object shape; throws on a malformed file (fail-closed). */
export function assertValidState(obj: unknown): asserts obj is SoakState {
  if (
    typeof obj !== "object" ||
    obj === null ||
    (obj as SoakState).kind !== "cosmos-soak-sync-state" ||
    (obj as SoakState).version !== 1 ||
    typeof (obj as SoakState).orgs !== "object" ||
    (obj as SoakState).orgs === null
  ) {
    throw new Error(
      "soak-sync: --state file is not a valid cosmos-soak-sync-state v1 document (refusing to proceed; a corrupt state could skip changed rows)",
    );
  }
}
