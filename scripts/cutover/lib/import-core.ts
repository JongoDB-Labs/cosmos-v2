// scripts/cutover/lib/import-core.ts
//
// SHARED idempotent-import engine — the single-transaction, FK-safe, UPSERT-per-row load with
// DataClassification dedupe + the in-transaction orphan-probe backstop. Extracted from
// import-org.mjs so BOTH the file-driven full import AND the in-memory soak-sync delta replay
// use ONE implementation (no duplication, no drift in the replica-role / dedupe / orphan-gate
// semantics).
//
// One owner transaction:
//   BEGIN;
//   SET LOCAL session_replication_role = replica;   -- suppress FK + user + append-only triggers
//   <per table, in plan order: idempotent UPSERT per row (append-only DO NOTHING; mutable
//    DO UPDATE WHERE EXCLUDED.updated_at > target.updated_at)>
//   <DataClassification: dedupe-with-audit then UPSERT survivors>
//   <orphan probe — ANY dangling FK ⇒ throw ⇒ ROLLBACK>
//   COMMIT;
//
// The caller supplies the org id (re-asserted per row), the live ModelPlans, and the table
// import units (model + columns + categories + encoded rows). The transaction + connection are
// owned here.

import pg from "pg";
import {
  type ModelPlan,
  rankOf,
  discoverOrphanProbeTargets,
  orphanProbeSql,
} from "./model-graph";
import { decodeRow, type PgTypeCategory } from "./ndjson-codec";
import { buildUpsert, dedupeClassifications, type ClassificationRow } from "./upsert";

/** One table's rows to import, with the column order + per-column decode categories. */
export interface ImportTableUnit {
  model: string;
  table: string;
  columns: string[];
  categories: Record<string, PgTypeCategory>;
  /** Encoded NDJSON-shaped rows (column → encoded value). */
  rows: Record<string, unknown>[];
}

export interface ImportResult {
  table: string;
  model: string;
  rowsInFile: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export interface ImportSummary {
  results: ImportResult[];
  dedupDrops: ReturnType<typeof dedupeClassifications>["drops"];
  totals: { inserted: number; updated: number; skipped: number };
  probeChecked: number;
}

/**
 * Run the idempotent import of `units` into the target, in ONE owner transaction. `plans` is
 * the live ModelPlan set (for the per-model UPSERT shape + the orphan probe). Throws (and rolls
 * back) on any cross-org row, any unknown model, or any dangling FK after load.
 *
 * Set `runOrphanProbe=false` ONLY when an outer transaction will run it (e.g. the reconcile
 * does its delete-extras + a single orphan probe in its own transaction). Default true.
 */
export async function importUnits(
  client: pg.Client,
  plans: ModelPlan[],
  org: string,
  units: ImportTableUnit[],
  opts: { log?: (msg: string) => void; runOrphanProbe?: boolean } = {},
): Promise<ImportSummary> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const runOrphanProbe = opts.runOrphanProbe ?? true;
  const planByModel = new Map(plans.map((p) => [p.model, p]));

  const results: ImportResult[] = [];
  let dedupDrops: ImportSummary["dedupDrops"] = [];
  let probeChecked = 0;

  try {
    await client.query("BEGIN");
    // Confirms owner (cosmos_app cannot set this) AND suppresses FK + append-only triggers.
    await client.query("SET LOCAL session_replication_role = replica");

    for (const unit of units) {
      const plan = planByModel.get(unit.model);
      if (!plan) {
        throw new Error(
          `import-core: table ${unit.table} (${unit.model}) is not a migratable model in the current schema — aborting`,
        );
      }

      // DataClassification: dedupe-with-audit BEFORE inserting (one ceiling per org).
      let importRows = unit.rows;
      if (plan.model === "DataClassification") {
        const { kept, drops } = dedupeClassifications(unit.rows as unknown as ClassificationRow[], rankOf);
        importRows = kept as unknown as Record<string, unknown>[];
        dedupDrops = drops;
        for (const d of drops) {
          log(
            `import-core: DataClassification DEDUPE — org ${d.orgId} ceiling: keep ${d.keptLevel} (${d.keptId}), ` +
              `drop ${d.droppedLevel} (${d.droppedId})${d.droppedMarkings.length ? ` [dropped markings: ${d.droppedMarkings.join(", ")}]` : ""}`,
          );
        }
      }

      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      for (const row of importRows) {
        // Strict org-scope re-assertion: never write another org's row, even if the input
        // somehow contained one. MEMBER-scoped Users carry no org_id; the ROOT Organization
        // row's id == org and is checked below.
        if ("org_id" in row && row.org_id !== null && row.org_id !== org) {
          throw new Error(
            `import-core: row in ${unit.table} has org_id ${row.org_id} != ${org} — refusing cross-org write`,
          );
        }
        if (plan.scope.kind === "ROOT" && row.id !== org) {
          throw new Error(
            `import-core: organizations row id ${row.id} != ${org} — refusing cross-org write`,
          );
        }
        const values = decodeRow(row, unit.columns, unit.categories);
        const stmt = buildUpsert(plan, unit.columns, values);
        const r = await client.query(stmt.sql, stmt.params);
        if (!r.rowCount) skipped++;
        else if (r.rows[0].__inserted === true) inserted++;
        else updated++;
      }

      results.push({ table: unit.table, model: unit.model, rowsInFile: unit.rows.length, inserted, updated, skipped });
      log(
        `import-core: ${unit.table.padEnd(28)} +${String(inserted).padStart(6)} ~${String(updated).padStart(6)} =${String(skipped).padStart(6)} (skipped)`,
      );
    }

    // ── REFERENTIAL-INTEGRITY BACKSTOP — fail the WHOLE import if any FK dangles. ──
    if (runOrphanProbe) {
      const probeTargets = await discoverOrphanProbeTargets(client, plans);
      probeChecked = probeTargets.length;
      const orphans: string[] = [];
      for (const pt of probeTargets) {
        const r = await client.query(orphanProbeSql(pt));
        if (r.rowCount && r.rowCount > 0) {
          orphans.push(
            `${pt.childTable}.${pt.childColumn} -> ${pt.parentTable}.${pt.parentColumn} ` +
              `(${pt.hardFk ? "FK " + pt.constraint : pt.constraint}) e.g. ${JSON.stringify(r.rows[0].orphan_fk)}`,
          );
        }
      }
      if (orphans.length > 0) {
        throw new Error(
          `import-core: REFERENTIAL INTEGRITY FAILURE — ${orphans.length} dangling FK(s) after load; ` +
            `rolling back (the migrated set is incomplete):\n  - ${orphans.join("\n  - ")}`,
        );
      }
      log(`import-core: referential probe CLEAN — ${probeChecked} FK target(s) checked, 0 orphans.`);
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

  const totals = results.reduce(
    (acc, r) => {
      acc.inserted += r.inserted;
      acc.updated += r.updated;
      acc.skipped += r.skipped;
      return acc;
    },
    { inserted: 0, updated: 0, skipped: 0 },
  );

  return { results, dedupDrops, totals, probeChecked };
}
