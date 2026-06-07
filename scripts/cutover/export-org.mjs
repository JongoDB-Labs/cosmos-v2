#!/usr/bin/env node
// scripts/cutover/export-org.mjs — PER-TENANT EXPORT (design spec §9.3).
//
//   Run under tsx (imports the .ts model-graph + codec):
//     npx tsx scripts/cutover/export-org.mjs \
//       --source <SOURCE_DATABASE_URL> --org <orgId> --out <dir> --stamp <iso8601>
//
// For every migratable org-scoped model (derived from the DMMF — see lib/model-graph.ts):
//   1. resolve the COPYABLE columns from the LIVE source (DMMF scalars ∩ live columns,
//      minus GENERATED content_tsv, minus search_vector, minus db-only embedding);
//   2. SELECT the org-scoped rows (resolve the org-scope path — DIRECT/PARENT/ROOT/MEMBER),
//      strictly filtered to THIS org, in deterministic PK order;
//   3. capture each column's PG type CATEGORY (bytea/timestamp/json/passthrough) from the
//      query field metadata so the import can decode losslessly;
//   4. REFERENTIAL CLOSURE (C1 + C2): pull in the FK-referenced PARENT rows the strict scope
//      excluded — GLOBAL built-ins (org_id IS NULL: work_item_types/project_templates/…) and
//      non-member USERS still referenced by a migrated row — so the imported set is
//      referentially COMPLETE (no dangling FK). FK edges are derived from the DMMF + the
//      enumerated bare user refs (see model-graph fkEdgesOf). Closure rows are SHARED (not
//      org-owned); they UPSERT idempotently on import.
//   5. write one NDJSON file per table (lossless type-aware encoding — numeric/bigint stay
//      strings ⇒ exact; bytea→base64; timestamp→ISO; json→JSON);
//   6. emit a manifest.json (per-table counts + columns + categories + the source orgId +
//      the caller-supplied stamp; closure-row counts are reported separately per table).
//
// BUILD-ONLY / SYNTHETIC-TEST ONLY. Never point --source at a production database without
// the documented freeze + sign-off (see docs/runbooks/cutover.md). This script only READS.
//
// `--stamp` is taken as a CLI arg on purpose: scripts under tsx may run in a context where
// Date.now()/new Date() is restricted; the caller supplies the cutover timestamp.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { buildModelPlans } from "./lib/model-graph.ts";
import { collectOrgRows } from "./lib/export-core.ts";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") out.source = argv[++i];
    else if (a === "--org") out.org = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--stamp") out.stamp = argv[++i];
    else {
      console.error(`export-org: unknown arg ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function req(args, name) {
  if (!args[name]) {
    console.error(`export-org: missing required --${name}`);
    process.exit(2);
  }
  return args[name];
}

// Basic UUID guard so a typo can't widen the scope to something unexpected.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const args = parseArgs(process.argv);
  const source = req(args, "source");
  const org = req(args, "org");
  const out = req(args, "out");
  const stamp = req(args, "stamp");

  if (!UUID_RE.test(org)) {
    console.error(`export-org: --org ${org} is not a UUID`);
    process.exit(2);
  }

  await mkdir(out, { recursive: true });
  const tablesDir = path.join(out, "tables");
  await mkdir(tablesDir, { recursive: true });

  const client = new pg.Client({ connectionString: source });
  await client.connect();

  const allPlans = buildModelPlans();

  // Defensive source-existence filter: a migratable v2 model whose table does NOT exist in
  // the SOURCE (prod) DB is a v2-only addition (e.g. agent_policy/org_runtime_config) with
  // nothing to migrate — skip it rather than fail resolveColumns. Belt-and-suspenders on top
  // of V2_ONLY_MODELS, so a future v2-only model can't break a cutover.
  const { rows: srcTblRows } = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public'",
  );
  const sourceTables = new Set(srcTblRows.map((r) => r.table_name));
  const plans = allPlans.filter((p) => sourceTables.has(p.table));
  const skipped = allPlans.filter((p) => !sourceTables.has(p.table)).map((p) => p.table);
  if (skipped.length) {
    console.log(`export-org: skipping ${skipped.length} table(s) absent from the source (v2-only): ${skipped.join(", ")}`);
  }

  let grandTotal = 0;
  let state;

  try {
    // Phases 1 (strict org-scope) + 2 (referential closure) are the SHARED export core,
    // reused verbatim by soak-sync's delta replay. No deltaFilters ⇒ a FULL export.
    state = await collectOrgRows(client, plans, org, {
      log: (m) => console.log(m.replace(/^export-core:/, "export-org:")),
    });
  } catch (err) {
    await client.end();
    console.error(`export-org: FAILED — ${err?.stack ?? err}`);
    process.exit(1);
  }

  await client.end();

  // ── Phase 3: write NDJSON files + manifest (in the deterministic plan order) ──
  const manifestTables = [];
  for (const plan of plans) {
    const st = state.get(plan.table);
    const lines = st.rows.map((obj) => JSON.stringify(obj));
    const ndjson = lines.length ? lines.join("\n") + "\n" : "";
    const fileName = `${plan.table}.ndjson`;
    await writeFile(path.join(tablesDir, fileName), ndjson, "utf8");

    manifestTables.push({
      model: plan.model,
      table: plan.table,
      file: path.join("tables", fileName),
      pk: plan.pk,
      appendOnly: plan.appendOnly,
      updatedAtColumn: plan.updatedAtColumn,
      moneyColumns: plan.moneyColumns,
      scopeKind: plan.scope.kind,
      columns: st.columns,
      categories: st.categories,
      stripped: st.stripped,
      rowCount: st.rows.length,
      scopedRowCount: st.scopedCount,
      closureRowCount: st.closureCount,
    });
    grandTotal += st.rows.length;
  }

  const totalClosure = manifestTables.reduce((n, t) => n + t.closureRowCount, 0);
  const manifest = {
    kind: "cosmos-cutover-export",
    version: 1,
    orgId: org,
    stamp,
    exportedTableCount: manifestTables.length,
    totalRows: grandTotal,
    closureRows: totalClosure,
    tables: manifestTables,
  };
  await writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.log(
    `\nexport-org: wrote ${grandTotal} rows across ${manifestTables.length} tables for org ${org}\n` +
      `  closure:  ${totalClosure} shared parent row(s) carried for referential integrity\n` +
      `  out:      ${out}\n` +
      `  manifest: ${path.join(out, "manifest.json")}`,
  );
}

main().catch((err) => {
  console.error(`export-org: unexpected error — ${err?.stack ?? err}`);
  process.exit(1);
});
