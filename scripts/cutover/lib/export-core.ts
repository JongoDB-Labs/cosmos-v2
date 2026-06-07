// scripts/cutover/lib/export-core.ts
//
// SHARED export collection engine — the Phase-1 (strict org-scope) + Phase-2 (referential
// closure) read logic, extracted from export-org.mjs so BOTH the full per-tenant export AND
// the incremental soak-sync delta replay use ONE implementation (no duplication, no drift).
//
// `collectOrgRows()` returns the per-table in-memory state (encoded rows, columns, type
// categories, scoped/closure counts, observed watermark values) for ONE org. The caller
// decides what to do with it:
//   - export-org.mjs writes NDJSON files + a manifest from it (full export).
//   - soak-sync.mjs imports it directly (delta replay) and advances watermarks from the
//     observed watermark values.
//
// THE ONLY DIFFERENCE between a full export and a delta export is the optional `deltaFilters`
// map: a per-table { sql, value } fragment ANDed into the strict org-scope SELECT (the
// watermark `col > :last`). It can ONLY narrow the result (it is ANDed onto `WHERE org = $1`)
// — the org-scope stays strict, so a delta can NEVER pull another org's rows. When no filter
// is supplied for a table (or none at all), that table is exported in FULL org-scope.
//
// IMPORTANT — the referential closure runs IDENTICALLY in both modes. A delta that pulls in a
// changed/new child whose parent (a global built-in, a shared user) isn't in the delta still
// carries that parent BY ID, so the imported delta is referentially complete. Closure parents
// are SHARED (idempotent UPSERT) — they are NEVER counted as "the org's changed rows".
//
// Runs the multi-table read inside ONE REPEATABLE READ READ ONLY snapshot for a self-consistent
// cross-table view (same as the original exporter).

import pg from "pg";
import {
  type ModelPlan,
  resolveColumns,
  buildScopedSelect,
  fkEdgesOf,
  quoteIdent,
} from "./model-graph";
import { categoryForOid, encodeRow, type PgTypeCategory } from "./ndjson-codec";

/** Per-table accumulated export state (mirrors export-org.mjs's `state` map values). */
export interface TableExportState {
  model: string;
  /** Encoded-row objects (column→encoded value), in insertion order (scoped then closure). */
  rows: Record<string, unknown>[];
  /** Set of exported single-PK ids (closure dedupe). Composite-PK tables aren't closure targets. */
  ids: Set<unknown>;
  /** The resolved copyable column list. */
  columns: string[];
  /** column → PG type category (for lossless decode on import). */
  categories: Record<string, PgTypeCategory>;
  /** The single PK column (for closure id tracking). */
  pk: string;
  /** Columns dropped on copy, with reasons (for the manifest). */
  stripped: { column: string; reason: string }[];
  /** Rows from the strict org-scope (before closure). */
  scopedCount: number;
  /** Rows added by the referential closure (shared parents). */
  closureCount: number;
  /**
   * The watermark VALUES observed among the SCOPED rows (not closure rows), as raw exported
   * values for the table's watermark column — used by soak-sync to advance the watermark.
   * Empty when the table has no watermark column or no scoped rows.
   */
  observedWatermarks: (string | null)[];
}

/** Optional per-table delta filter (the watermark `col > :last`). Keyed by physical table. */
export type DeltaFilters = Map<string, { sql: string; value: unknown }>;

export interface CollectOptions {
  /** Per-table delta filter; omit for a full export. */
  deltaFilters?: DeltaFilters;
  /**
   * The watermark column per table (physical table → column | null), so we can capture the
   * observed watermark values from the scoped rows. Omit when the caller doesn't need them
   * (full export-org doesn't advance any watermark).
   */
  watermarkColumns?: Map<string, string | null>;
  /** A logger; defaults to console.log. Pass a no-op to silence. */
  log?: (msg: string) => void;
}

/**
 * Collect every migratable org-scoped model's rows for ONE org, plus the referential closure
 * of referenced parents. Returns a Map keyed by physical table. The DB read runs inside a
 * single read-only repeatable-read snapshot. The caller owns the client lifecycle (connect/end)
 * and the transaction is opened+committed here.
 */
export async function collectOrgRows(
  client: pg.Client,
  plans: ModelPlan[],
  org: string,
  opts: CollectOptions = {},
): Promise<Map<string, TableExportState>> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const planByTable = new Map(plans.map((p) => [p.table, p]));
  const state = new Map<string, TableExportState>();

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    // ── Phase 1: strict org-scoped export (+ optional delta filter) of every model ──
    for (const plan of plans) {
      const colPlan = await resolveColumns(client, plan.model);
      const delta = opts.deltaFilters?.get(plan.table);
      const { sql, params } = buildScopedSelect(plan, colPlan.columns, org, delta);
      const res = await client.query({ text: sql, values: params, rowMode: "array" });

      const categories: Record<string, PgTypeCategory> = {};
      res.fields.forEach((f, i) => {
        categories[colPlan.columns[i]] = categoryForOid(f.dataTypeID);
      });

      const pkCol = plan.pk[0];
      const wmCol = opts.watermarkColumns?.get(plan.table) ?? null;
      const wmIdx = wmCol ? colPlan.columns.indexOf(wmCol) : -1;
      const ids = new Set<unknown>();
      const observedWatermarks: (string | null)[] = [];
      const rows = res.rows.map((arr: unknown[]) => {
        const obj: Record<string, unknown> = {};
        colPlan.columns.forEach((c, i) => (obj[c] = arr[i]));
        if (plan.pk.length === 1 && obj[pkCol] != null) ids.add(obj[pkCol]);
        // Capture the watermark value (raw — Date or string) before encoding.
        if (wmIdx >= 0) {
          const wv = arr[wmIdx];
          observedWatermarks.push(wv == null ? null : isoOf(wv));
        }
        return encodeRow(obj, colPlan.columns);
      });

      state.set(plan.table, {
        model: plan.model,
        rows,
        ids,
        columns: colPlan.columns,
        categories,
        pk: pkCol,
        stripped: colPlan.stripped,
        scopedCount: rows.length,
        closureCount: 0,
        observedWatermarks,
      });
      log(
        `export-core: ${plan.table.padEnd(28)} ${String(rows.length).padStart(7)} rows  [${plan.scope.kind}]` +
          (delta ? "  (delta)" : ""),
      );
    }

    // ── Phase 2: REFERENTIAL CLOSURE — pull referenced parent rows the strict scope missed ──
    // Identical to export-org.mjs: iterate to a fixpoint, adding ONLY referenced parent rows
    // (users/globals) BY ID, never widening the org's own data. Closure rows are NOT counted
    // as scoped/changed (closureCount tracks them separately) and do NOT contribute to the
    // observed watermark (we only advance from the org's own scoped rows).
    let closureAdded = 0;
    for (let pass = 1; ; pass++) {
      const want = new Map<string, Set<unknown>>();
      for (const [, st] of state) {
        const edges = fkEdgesOf(st.model);
        if (edges.length === 0) continue;
        for (const e of edges) {
          const target = state.get(e.targetTable);
          if (!target) continue;
          for (const row of st.rows) {
            const v = (row as Record<string, unknown>)[e.fkColumn];
            if (v == null) continue;
            if (target.ids.has(v)) continue;
            let set = want.get(e.targetTable);
            if (!set) {
              set = new Set();
              want.set(e.targetTable, set);
            }
            set.add(v);
          }
        }
      }

      if (want.size === 0) break;

      let addedThisPass = 0;
      for (const [table, idSet] of want) {
        const st = state.get(table);
        const plan = planByTable.get(table);
        if (!st || !plan) continue;
        const ids = [...idSet].filter((id) => !st.ids.has(id));
        if (ids.length === 0) continue;

        const t = quoteIdent(table);
        const cols = st.columns.map((c) => `${t}.${quoteIdent(c)}`).join(", ");
        const idCol = quoteIdent(st.pk);
        const { rows: parentRows } = await client.query({
          text: `SELECT ${cols} FROM ${t} WHERE ${t}.${idCol} = ANY($1::uuid[]) ORDER BY ${t}.${idCol} ASC`,
          values: [ids],
          rowMode: "array",
        });

        for (const arr of parentRows as unknown[][]) {
          const obj: Record<string, unknown> = {};
          st.columns.forEach((c, i) => (obj[c] = arr[i]));
          const id = obj[st.pk];
          if (id == null || st.ids.has(id)) continue;
          st.ids.add(id);
          st.rows.push(encodeRow(obj, st.columns));
          st.closureCount++;
          addedThisPass++;
        }
      }

      closureAdded += addedThisPass;
      log(
        `export-core: closure pass ${pass}: +${addedThisPass} referenced parent row(s)` +
          (addedThisPass === 0 ? " (fixpoint reached)" : ""),
      );
      if (addedThisPass === 0) break;
    }
    if (closureAdded > 0) {
      log(`export-core: referential closure added ${closureAdded} shared parent row(s) total`);
    }

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }

  return state;
}

/** Normalize a watermark value (Date | string) to an ISO-8601 / string form for comparison. */
function isoOf(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
