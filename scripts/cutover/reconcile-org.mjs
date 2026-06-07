#!/usr/bin/env node
// scripts/cutover/reconcile-org.mjs — THE FINAL RECONCILE (run ONCE under freeze; design §9.4).
//
//   Run under tsx; the TARGET url must be the DB OWNER:
//     npx tsx scripts/cutover/reconcile-org.mjs \
//       --source <SOURCE_DATABASE_URL> --target <OWNER_DATABASE_URL> --org <orgId> \
//       --stamp <iso> [--confirm-large] [--large-threshold <n>]
//
// PRECONDITION: the SOURCE is write-FROZEN (no new writes). The soak-sync has kept v2 caught up
// on inserts/updates; this final pass makes v2 EXACTLY match the frozen source — including the
// DELETES a watermark delta can't see — then the verify gate must be CLEAN before the flip.
//
// Three phases, fail-closed at every step:
//   1. FINAL FULL IDEMPOTENT IMPORT — catch any last delta (re-export the full org-scope +
//      referential closure, idempotent UPSERT). After this, every source row is present in v2.
//   2. DELETE-EXTRAS (the new part) — for each MUTABLE, ORG-OWNED (DIRECT/PARENT), NON-AUDIT
//      table, compute the org-scoped PK set in SOURCE vs TARGET and DELETE from the target the
//      PKs that are in TARGET-BUT-NOT-SOURCE (the rows deleted in the source during soak), in
//      ONE owner transaction with SET LOCAL session_replication_role = replica, ordered
//      CHILDREN-BEFORE-PARENTS (reverse FK-topological) so no retained child is stranded.
//      HARD INVARIANTS: NEVER delete append-only/audit, the closure parents (shared
//      users/globals), or another org's rows (all guaranteed by the org-scoped PK-set diff +
//      the by-name guards). A delete count over --large-threshold (default 10000) ⇒ FAIL unless
//      --confirm-large (a huge count = a likely scoping bug).
//   3. ORPHAN PROBE — inside the SAME transaction, after the deletes, run the generic dangling-
//      FK probe. ANY orphan ⇒ ROLLBACK the whole reconcile (a delete that would strand a child
//      is rejected; the operator investigates). Only on a CLEAN probe do we COMMIT.
//   4. VERIFY GATE — run verify-org (counts + per-row money + markings + checksums + orphan
//      probe). Counts now match EXACTLY (deletes applied). A clean verify is the flip gate.
//
// BUILD-ONLY / SYNTHETIC-TEST ONLY. Never point at production without the runbook + sign-off.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import {
  buildModelPlans,
  orderForDelete,
  discoverOrphanProbeTargets,
  orphanProbeSql,
} from "./lib/model-graph.ts";
import { collectOrgRows } from "./lib/export-core.ts";
import { importUnits } from "./lib/import-core.ts";
import { computeDeletePlans, executeDeletes } from "./lib/reconcile-core.ts";

const DEFAULT_LARGE_THRESHOLD = 10000;

function parseArgs(argv) {
  const out = { confirmLarge: false, largeThreshold: DEFAULT_LARGE_THRESHOLD };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") out.source = argv[++i];
    else if (a === "--target") out.target = argv[++i];
    else if (a === "--org") out.org = argv[++i];
    else if (a === "--stamp") out.stamp = argv[++i];
    else if (a === "--confirm-large") out.confirmLarge = true;
    else if (a === "--large-threshold") out.largeThreshold = Number(argv[++i]);
    else {
      console.error(`reconcile-org: unknown arg ${a}`);
      process.exit(2);
    }
  }
  return out;
}
function req(args, name) {
  if (!args[name]) {
    console.error(`reconcile-org: missing required --${name}`);
    process.exit(2);
  }
  return args[name];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const args = parseArgs(process.argv);
  const source = req(args, "source");
  const target = req(args, "target");
  const org = req(args, "org");
  if (!UUID_RE.test(org)) {
    console.error(`reconcile-org: --org ${org} is not a UUID`);
    process.exit(2);
  }
  const stamp = args.stamp ?? "(no --stamp)";

  const plans = buildModelPlans();

  console.log(`\n════════ reconcile-org: org ${org} @ ${stamp} ════════`);
  console.log("PRECONDITION: the SOURCE must be write-FROZEN. This applies DELETES to the target.\n");

  // ── Phase 1: FINAL FULL IDEMPOTENT IMPORT (catch any last delta) ──
  console.log("──── Phase 1: final full idempotent import ────");
  const src1 = new pg.Client({ connectionString: source });
  await src1.connect();
  let collected;
  try {
    collected = await collectOrgRows(src1, plans, org, {
      log: (m) => console.log(m.replace(/^export-core:/, "reconcile-org[export]:")),
    });
  } finally {
    await src1.end();
  }
  const units = plans.map((plan) => {
    const st = collected.get(plan.table);
    return { model: plan.model, table: plan.table, columns: st.columns, categories: st.categories, rows: st.rows };
  });
  const tgt1 = new pg.Client({ connectionString: target });
  await tgt1.connect();
  let importSummary;
  try {
    importSummary = await importUnits(tgt1, plans, org, units, {
      log: (m) => console.log(m.replace(/^import-core:/, "reconcile-org[import]:")),
    });
  } finally {
    await tgt1.end();
  }
  console.log(
    `reconcile-org: import — inserted ${importSummary.totals.inserted}, updated ${importSummary.totals.updated}, ` +
      `skipped ${importSummary.totals.skipped}, dedupe drops ${importSummary.dedupDrops.length}`,
  );

  // ── Phase 2: DELETE-EXTRAS (org-scoped PK-set diff, children-before-parents) ──
  console.log("\n──── Phase 2: delete-extras (rows deleted in the frozen source) ────");
  const src2 = new pg.Client({ connectionString: source });
  const tgt2 = new pg.Client({ connectionString: target });
  await src2.connect();
  await tgt2.connect();

  let deleteResult;
  try {
    // Children-before-parents order, derived from the live target catalog.
    const orderedEligible = await orderForDelete(tgt2, plans);
    console.log(
      `reconcile-org: ${orderedEligible.length} mutable org-owned non-audit table(s) eligible for delete-extras ` +
        `(children-before-parents order).`,
    );

    // Compute the per-table delete sets (read-only diff) BEFORE opening the delete transaction.
    const deletePlans = await computeDeletePlans(src2, tgt2, orderedEligible, org);
    const totalToDelete = deletePlans.reduce((n, dp) => n + dp.extras.length, 0);
    const withDeletes = deletePlans.filter((dp) => dp.extras.length > 0);
    if (withDeletes.length > 0) {
      console.log("reconcile-org: planned deletes (target-minus-source, org-scoped):");
      for (const dp of withDeletes) {
        console.log(
          `reconcile-org:   ${dp.plan.table.padEnd(28)} ${String(dp.extras.length).padStart(6)} ` +
            `(source ${dp.sourceCount} / target ${dp.targetCount})`,
        );
      }
    } else {
      console.log("reconcile-org: no extra rows to delete (target already matches source PK sets).");
    }

    // Fail-closed on a suspiciously large delete count (likely a scoping bug).
    if (totalToDelete > args.largeThreshold && !args.confirmLarge) {
      throw new Error(
        `reconcile-org: planned delete-extras count ${totalToDelete} exceeds --large-threshold ` +
          `${args.largeThreshold}. A huge delete count is almost always a SCOPING BUG, not a real ` +
          `mass-deletion. Refusing (fail-closed). Re-run with --confirm-large ONLY after verifying ` +
          `the per-table counts above are correct.`,
      );
    }

    // Execute the deletes + orphan probe in ONE owner transaction; commit only if probe is clean.
    await tgt2.query("BEGIN");
    await tgt2.query("SET LOCAL session_replication_role = replica");
    deleteResult = await executeDeletes(tgt2, deletePlans, org, (m) => console.log(m.replace(/^reconcile-core:/, "reconcile-org:")));

    // ── Phase 3: orphan probe INSIDE the delete transaction — any dangling FK ⇒ ROLLBACK ──
    const probeTargets = await discoverOrphanProbeTargets(tgt2, plans);
    const orphans = [];
    for (const pt of probeTargets) {
      const r = await tgt2.query(orphanProbeSql(pt));
      if (r.rowCount && r.rowCount > 0) {
        orphans.push(
          `${pt.childTable}.${pt.childColumn} -> ${pt.parentTable}.${pt.parentColumn} ` +
            `(${pt.hardFk ? "FK " + pt.constraint : pt.constraint}) e.g. ${JSON.stringify(r.rows[0].orphan_fk)}`,
        );
      }
    }
    if (orphans.length > 0) {
      throw new Error(
        `reconcile-org: DELETE-EXTRAS would leave ${orphans.length} dangling FK(s) — ROLLING BACK ` +
          `the entire reconcile (a delete stranded a retained child):\n  - ${orphans.join("\n  - ")}`,
      );
    }
    console.log(
      `reconcile-org: orphan probe CLEAN after deletes — ${probeTargets.length} FK target(s), 0 orphans. Committing.`,
    );
    await tgt2.query("COMMIT");
    console.log(`reconcile-org: delete-extras COMMITTED — ${deleteResult.totalDeleted} row(s) deleted total.`);
  } catch (err) {
    try {
      await tgt2.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    await src2.end();
    await tgt2.end();
    console.error(`reconcile-org: Phase 2/3 FAILED — ${err?.stack ?? err}`);
    process.exit(1);
  }
  await src2.end();
  await tgt2.end();

  // ── Phase 4: VERIFY GATE (counts now match exactly; the flip gate) ──
  console.log("\n──── Phase 4: verify gate (the hard flip gate) ────");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const verifyScript = path.join(here, "verify-org.mjs");
  const code = await runVerify(verifyScript, source, target, org);
  if (code !== 0) {
    console.error(`\nreconcile-org: VERIFY GATE FAILED (exit ${code}). Do NOT flip. Investigate.`);
    process.exit(code);
  }

  console.log(
    `\n════════ reconcile-org: org ${org} RECONCILED + VERIFIED CLEAN ════════\n` +
      `  imported (final): +${importSummary.totals.inserted} ~${importSummary.totals.updated}\n` +
      `  deleted (extras): ${deleteResult.totalDeleted}\n` +
      `  Flip GATE PASSED — v2 now EXACTLY matches the frozen source.`,
  );
  // Stable machine-readable line for the acceptance to grep.
  console.log(
    `RECONCILE_TOTALS ${JSON.stringify({ inserted: importSummary.totals.inserted, updated: importSummary.totals.updated, deleted: deleteResult.totalDeleted, verifyClean: true })}`,
  );
}

/** Run verify-org.mjs as a child process and resolve its exit code (it owns the flip-gate logic). */
function runVerify(verifyScript, source, target, org) {
  return new Promise((resolve) => {
    const child = spawn(
      "npx",
      ["tsx", verifyScript, "--source", source, "--target", target, "--org", org],
      { stdio: "inherit" },
    );
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (e) => {
      console.error(`reconcile-org: failed to spawn verify-org — ${e?.stack ?? e}`);
      resolve(1);
    });
  });
}

main().catch((err) => {
  console.error(`reconcile-org: unexpected error — ${err?.stack ?? err}`);
  process.exit(1);
});
