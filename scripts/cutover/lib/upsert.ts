// scripts/cutover/lib/upsert.ts
//
// Idempotent-replay UPSERT SQL builders + the DataClassification dedupe-with-audit.
// These are PURE string/array builders (no DB) so they're unit-testable in isolation;
// import-org.mjs feeds the produced SQL+params to a single owner transaction.
//
// REPLAY SEMANTICS (design spec §9.4 — the soak-sync uses this same path):
//   - APPEND-ONLY models (no updated_at): INSERT … ON CONFLICT (<pk>) DO NOTHING.
//     A row that already exists (by PK) is left exactly as-is — re-running inserts 0.
//     This is correct for immutable history (ChatMessage, AuditLog, JournalLine, …) AND
//     for shared rows (a User already migrated by another org's cutover is not clobbered).
//   - MUTABLE models (have updated_at): INSERT … ON CONFLICT (<pk>) DO UPDATE … WHERE
//     EXCLUDED.updated_at > <table>.updated_at — last-writer-wins by SOURCE updatedAt.
//     A re-run with an unchanged source updates 0 (timestamps equal ⇒ WHERE false).
//
// L1 — `force` (EXACT) MODE for the FINAL under-freeze reconcile:
//   The last-writer-wins guard is CORRECT for SOAK deltas (the source is non-authoritative
//   live; we must not clobber). But the FINAL reconcile runs UNDER FREEZE where the source is
//   the AUTHORITATIVE exact state — the target must be made to EXACTLY match it. A source-side
//   cascaded SetNull (e.g. work_items.parent_id, an optional self-relation whose Prisma-default
//   onDelete is SetNull) does NOT bump the child's updated_at, so the guarded UPSERT never
//   propagates the NULL → the target keeps a stale parent_id → after delete-extras removes the
//   parent the child dangles → spurious orphan rollback (a fail-closed cutover HALT).
//   With `force: true`, a MUTABLE row's ON CONFLICT DO UPDATE drops the `WHERE EXCLUDED.updated_at
//   >` guard and overwrites UNCONDITIONALLY, so the target row matches the source EXACTLY
//   (catches SetNull-no-bump + any silent content drift). APPEND-ONLY models stay DO NOTHING
//   (immutable history — NEVER force-updated) in BOTH modes. Default (force omitted/false) is the
//   byte-unchanged v2.11 guarded path: ONLY the final reconcile passes force; soak deltas do not.
//
// The PK conflict target uses the FULL primary key (composite for the one join table),
// so a composite-key row replays on its real identity.
//
// IMPORTANT: these builders return a STATEMENT-PER-ROW (parameterized). That keeps each
// row's bind values exact (numeric stays a string ⇒ exact money) and lets us count
// inserted/updated/skipped precisely from each statement's rowCount. A multi-row VALUES
// batch would be faster but would blur per-row outcome accounting; correctness > speed.

import { quoteIdent, type ModelPlan } from "./model-graph";

export interface UpsertStatement {
  sql: string;
  params: unknown[];
}

/**
 * Build one parameterized UPSERT statement for a single row.
 *   columns : the exact column list (PK + data), in bind order.
 *   values  : decoded bind values aligned to `columns`.
 *   force   : EXACT mode (L1). When true, a MUTABLE row's ON CONFLICT DO UPDATE drops the
 *             `WHERE EXCLUDED.updated_at >` guard and overwrites UNCONDITIONALLY (the target is
 *             made to EXACTLY match the authoritative frozen source). APPEND-ONLY models stay
 *             DO NOTHING regardless (immutable history). Default false = the guarded last-writer-
 *             wins path used by soak deltas (byte-unchanged from v2.11).
 */
export function buildUpsert(
  plan: ModelPlan,
  columns: string[],
  values: unknown[],
  force = false,
): UpsertStatement {
  if (columns.length !== values.length) {
    throw new Error(
      `upsert: column/value arity mismatch for ${plan.table} (${columns.length} vs ${values.length})`,
    );
  }
  for (const pk of plan.pk) {
    if (!columns.includes(pk)) {
      throw new Error(`upsert: PK column ${pk} not present in columns for ${plan.table}`);
    }
  }

  const t = quoteIdent(plan.table);
  const colList = columns.map(quoteIdent).join(", ");
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const conflictTarget = plan.pk.map(quoteIdent).join(", ");

  // RETURNING (xmax = 0) lets the caller distinguish INSERT (xmax 0) from UPDATE (xmax != 0)
  // in ONE round-trip. When the conflict clause SKIPS (DO NOTHING, or DO UPDATE WHERE false),
  // no row is returned ⇒ rowCount 0 ⇒ "skipped". Exact per-row accounting, no extra queries.
  const returning = ` RETURNING (xmax = 0) AS __inserted`;

  if (plan.appendOnly) {
    // Immutable / shared rows: never overwrite an existing row.
    return {
      sql: `INSERT INTO ${t} (${colList}) VALUES (${placeholders}) ON CONFLICT (${conflictTarget}) DO NOTHING${returning}`,
      params: values,
    };
  }

  // Mutable: update every NON-PK column, but only when the source row is strictly newer.
  const ua = plan.updatedAtColumn;
  if (!ua) {
    throw new Error(`upsert: mutable model ${plan.table} has no updatedAtColumn`);
  }
  const pkSet = new Set(plan.pk);
  const setClause = columns
    .filter((c) => !pkSet.has(c))
    .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
    .join(", ");

  // Guard: a mutable model with ONLY pk columns can't DO UPDATE — fall back to DO NOTHING.
  if (setClause.length === 0) {
    return {
      sql: `INSERT INTO ${t} (${colList}) VALUES (${placeholders}) ON CONFLICT (${conflictTarget}) DO NOTHING${returning}`,
      params: values,
    };
  }

  if (force) {
    // EXACT mode (final reconcile, under freeze): overwrite UNCONDITIONALLY so the target row
    // matches the authoritative source exactly. No updated_at guard — this is what catches a
    // source-side SetNull that did NOT bump updated_at (e.g. work_items.parent_id) and any other
    // silent content drift the last-writer-wins delta would miss.
    return {
      sql:
        `INSERT INTO ${t} (${colList}) VALUES (${placeholders}) ` +
        `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${setClause}${returning}`,
      params: values,
    };
  }

  return {
    sql:
      `INSERT INTO ${t} (${colList}) VALUES (${placeholders}) ` +
      `ON CONFLICT (${conflictTarget}) DO UPDATE SET ${setClause} ` +
      `WHERE EXCLUDED.${quoteIdent(ua)} > ${t}.${quoteIdent(ua)}${returning}`,
    params: values,
  };
}

// ── DataClassification dedupe-with-audit (design spec §9 step 6) ──
//
// The org-CEILING rows are `(org_id, project_id IS NULL)`. Postgres treats NULLs as
// DISTINCT in a UNIQUE index, so v1 can legitimately hold MULTIPLE such rows — but v2
// enforces `@@unique([orgId, projectId])` (one ceiling per org). Before import we must
// collapse them to ONE, fail-CLOSED: keep the row with the HIGHEST rankOf(level). Every
// dropped row is LOGGED (to the cutover report). markings[] + handlingInstructions are
// carried VERBATIM on the survivor (they are the literal CUI banners — never rewritten).
//
// Project-scoped rows (project_id NOT NULL) are already unique per (org,project) and are
// passed through untouched.

export interface ClassificationRow {
  id: string;
  org_id: string;
  project_id: string | null;
  level: string;
  markings: string[];
  handling_instructions: string;
  // any other columns ride along verbatim
  [k: string]: unknown;
}

export interface DedupDrop {
  droppedId: string;
  droppedLevel: string;
  keptId: string;
  keptLevel: string;
  orgId: string;
  projectId: string | null;
  // The dropped row's markings — surfaced so a reviewer can confirm nothing CUI was lost
  // by the dedupe (the survivor keeps the HIGHER level; markings union is NOT performed —
  // we carry the survivor's markings verbatim, but we LOG the dropped markings for review).
  droppedMarkings: string[];
}

export interface DedupResult {
  /** The rows to actually import (one ceiling per org + all project rows), unchanged. */
  kept: ClassificationRow[];
  /** Every dropped duplicate, for the audit log / cutover report. */
  drops: DedupDrop[];
}

/**
 * Collapse duplicate org-ceiling rows, keeping the highest-rank level (fail-closed).
 * `rank` is injected (the model-graph rankOf) so this stays pure + testable.
 * markings/handlingInstructions on the SURVIVOR are untouched (verbatim).
 *
 * Tie-break when two ceilings share the same (highest) rank: keep the LEXICOGRAPHICALLY
 * smallest id — deterministic + stable, so a re-run dedupes to the identical survivor.
 */
export function dedupeClassifications(
  rows: ClassificationRow[],
  rank: (level: string) => number,
): DedupResult {
  const kept: ClassificationRow[] = [];
  const drops: DedupDrop[] = [];

  // Pass project-scoped rows straight through.
  const ceilingByOrg = new Map<string, ClassificationRow>();
  const ceilingRowsByOrg = new Map<string, ClassificationRow[]>();
  for (const r of rows) {
    if (r.project_id !== null && r.project_id !== undefined) {
      kept.push(r);
      continue;
    }
    const list = ceilingRowsByOrg.get(r.org_id) ?? [];
    list.push(r);
    ceilingRowsByOrg.set(r.org_id, list);
  }

  for (const [orgId, list] of ceilingRowsByOrg) {
    // Pick the survivor: highest rank, then smallest id (deterministic).
    let survivor = list[0];
    for (const r of list) {
      const better =
        rank(r.level) > rank(survivor.level) ||
        (rank(r.level) === rank(survivor.level) && r.id < survivor.id);
      if (better) survivor = r;
    }
    ceilingByOrg.set(orgId, survivor);
    kept.push(survivor);
    for (const r of list) {
      if (r.id === survivor.id) continue;
      drops.push({
        droppedId: r.id,
        droppedLevel: r.level,
        keptId: survivor.id,
        keptLevel: survivor.level,
        orgId,
        projectId: null,
        droppedMarkings: r.markings ?? [],
      });
    }
  }

  return { kept, drops };
}
