// scripts/cutover/lib/reconcile-core.ts
//
// THE DELETE-EXTRAS engine for the FINAL reconcile (design spec §9.4). A watermark delta replay
// (soak-sync) is insert/update-only — a row DELETED in the source during the soak simply stops
// appearing, so it LINGERS in v2. The final reconcile (run ONCE under freeze, source write-
// frozen) makes v2 EXACTLY match the source by removing those lingering rows.
//
// HARD INVARIANTS (the crux — fail-closed everywhere):
//   1. ONLY delete from tables that are org-owned (DIRECT/PARENT) ∩ mutable ∩ non-audit
//      (model-graph deleteExtrasPlans). NEVER append-only/audit, NEVER ROOT/MEMBER.
//   2. Delete BY ORG-SCOPED PK-SET DIFF: target-scoped PKs MINUS source-scoped PKs. Both PK
//      sets come from the STRICT org-scope SELECT, so:
//        - a CLOSURE PARENT (global built-in org_id IS NULL, shared non-member user) is in
//          NEITHER set → never a delete candidate.
//        - ANOTHER ORG's rows are in NEITHER set → never touched.
//   3. Order CHILDREN-BEFORE-PARENTS (reverse FK-topological) so a parent delete never strands
//      a retained child.
//   4. ONE owner transaction with SET LOCAL session_replication_role = replica (so a delete of
//      a parent whose child is ALSO being deleted doesn't trip a RESTRICT FK mid-transaction;
//      the complete post-delete set is what must be consistent — verified by the orphan probe).
//   5. After the deletes, run the orphan probe; ANY dangling FK ⇒ ROLLBACK the whole reconcile.
//   6. A delete count over a sane threshold ⇒ fail-closed unless --confirm-large (a huge delete
//      count almost always means a scoping bug, not a real mass-deletion).
//
// The pure PK-diff (computeExtras) is unit-tested with no DB. The DB-driving delete is exercised
// by the Docker acceptance.

import pg from "pg";
import {
  type ModelPlan,
  deleteForbiddenReason,
  buildScopedPkSelect,
  quoteIdent,
} from "./model-graph";

/**
 * The PKs present in the TARGET org-scope but absent from the SOURCE org-scope — i.e. the rows
 * deleted in the source that still linger in the target. Pure set difference on the single-PK
 * string values. (All delete-extras-eligible tables have single-UUID PKs.)
 */
export function computeExtras(sourcePks: string[], targetPks: string[]): string[] {
  const src = new Set(sourcePks);
  return targetPks.filter((pk) => !src.has(pk));
}

/** One table's delete plan: the eligible plan + the extra PKs to delete (target-minus-source). */
export interface TableDeletePlan {
  plan: ModelPlan;
  extras: string[];
  sourceCount: number;
  targetCount: number;
}

export interface DeleteExtrasResult {
  perTable: { table: string; deleted: number; sourceCount: number; targetCount: number }[];
  totalDeleted: number;
}

/** Fetch the org-scoped single-PK set for a table from a client (source or target). */
async function fetchScopedPkSet(
  client: pg.Client,
  plan: ModelPlan,
  org: string,
): Promise<string[]> {
  const { sql, params } = buildScopedPkSelect(plan, org);
  const res = await client.query({ text: sql, values: params, rowMode: "array" });
  // single-PK: each row is [pkValue]
  return res.rows.map((r: unknown[]) => String(r[0]));
}

/**
 * Compute the per-table delete plans (target-minus-source PK diff) for every eligible table,
 * in the supplied children-before-parents order. Read-only on both DBs (no deletes here).
 */
export async function computeDeletePlans(
  source: pg.Client,
  target: pg.Client,
  orderedEligible: ModelPlan[],
  org: string,
): Promise<TableDeletePlan[]> {
  const out: TableDeletePlan[] = [];
  for (const plan of orderedEligible) {
    // Defense in depth: refuse to even COMPUTE a delete set for a forbidden table.
    const forbidden = deleteForbiddenReason(plan);
    if (forbidden) {
      throw new Error(`reconcile-core: refusing delete-extras on ${plan.table} — ${forbidden}`);
    }
    const srcPks = await fetchScopedPkSet(source, plan, org);
    const tgtPks = await fetchScopedPkSet(target, plan, org);
    const extras = computeExtras(srcPks, tgtPks);
    out.push({ plan, extras, sourceCount: srcPks.length, targetCount: tgtPks.length });
  }
  return out;
}

/**
 * Execute the deletes inside ONE owner transaction (caller has already BEGUN it and SET LOCAL
 * session_replication_role = replica). Deletes each table's extra PKs in the supplied order
 * (children-before-parents). Re-asserts the forbidden guard immediately before every DELETE.
 * Deletes are batched with `id = ANY($1::uuid[])` (parameterized) and the rowCount is checked
 * to equal the expected extras (a mismatch ⇒ throw ⇒ the caller rolls back).
 *
 * Returns the per-table delete counts. Does NOT commit — the caller runs the orphan probe +
 * verify, then commits or rolls back.
 */
export async function executeDeletes(
  target: pg.Client,
  deletePlans: TableDeletePlan[],
  org: string,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<DeleteExtrasResult> {
  const perTable: DeleteExtrasResult["perTable"] = [];
  let totalDeleted = 0;

  for (const dp of deletePlans) {
    const { plan, extras } = dp;
    // Re-assert the hard guard right before deleting (belt + suspenders).
    const forbidden = deleteForbiddenReason(plan);
    if (forbidden) {
      throw new Error(`reconcile-core: BLOCKED delete on ${plan.table} — ${forbidden}`);
    }
    if (extras.length === 0) {
      perTable.push({ table: plan.table, deleted: 0, sourceCount: dp.sourceCount, targetCount: dp.targetCount });
      continue;
    }

    const t = quoteIdent(plan.table);
    const pk = quoteIdent(plan.pk[0]);
    // Delete by the explicit extra-PK list. We additionally re-scope by org_id for DIRECT tables
    // as a final safety net so a delete can NEVER touch another org's row even if the PK list
    // were somehow wrong (a PARENT-scoped table has no org_id column; its PKs already came from
    // the org-scoped diff, which is itself org-bounded by the FK-chain join).
    let sql: string;
    let params: unknown[];
    if (plan.scope.kind === "DIRECT") {
      const orgCol = quoteIdent(plan.scope.orgIdColumn!);
      sql = `DELETE FROM ${t} WHERE ${pk} = ANY($1::uuid[]) AND ${orgCol} = $2`;
      params = [extras, org];
    } else {
      sql = `DELETE FROM ${t} WHERE ${pk} = ANY($1::uuid[])`;
      params = [extras];
    }
    const r = await target.query(sql, params);
    const deleted = r.rowCount ?? 0;
    if (deleted !== extras.length) {
      // A row we computed as "extra" wasn't deleted (e.g. org_id mismatch on the safety net, or
      // it vanished mid-txn). Fail-closed: the operator must investigate; do not commit a
      // partial reconcile.
      throw new Error(
        `reconcile-core: ${plan.table} delete count ${deleted} != expected ${extras.length} ` +
          `(org-scope safety net or concurrent change?) — failing closed`,
      );
    }
    totalDeleted += deleted;
    perTable.push({ table: plan.table, deleted, sourceCount: dp.sourceCount, targetCount: dp.targetCount });
    log(`reconcile-core: ${plan.table.padEnd(28)} deleted ${String(deleted).padStart(6)} extra row(s) [${plan.scope.kind}]`);
  }

  return { perTable, totalDeleted };
}
