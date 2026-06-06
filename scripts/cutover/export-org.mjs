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
//   3. capture each column's PG type CATEGORY (bytea/timestamp/passthrough) from the query
//      field metadata so the import can decode losslessly;
//   4. write one NDJSON file per table (lossless type-aware encoding — numeric/bigint stay
//      strings ⇒ exact; bytea→base64; timestamp→ISO);
//   5. emit a manifest.json (per-table counts + columns + categories + the source orgId +
//      the caller-supplied stamp).
//
// BUILD-ONLY / SYNTHETIC-TEST ONLY. Never point --source at a production database without
// the documented freeze + sign-off (see docs/runbooks/cutover.md). This script only READS.
//
// `--stamp` is taken as a CLI arg on purpose: scripts under tsx may run in a context where
// Date.now()/new Date() is restricted; the caller supplies the cutover timestamp.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { buildModelPlans, resolveColumns, buildScopedSelect } from "./lib/model-graph.ts";
import { categoryForOid, encodeRow } from "./lib/ndjson-codec.ts";

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

  const plans = buildModelPlans();
  const manifestTables = [];
  let grandTotal = 0;

  try {
    // Read-only, repeatable snapshot for a self-consistent multi-table export.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    for (const plan of plans) {
      const colPlan = await resolveColumns(client, plan.model);
      const { sql, params } = buildScopedSelect(plan, colPlan.columns, org);
      const res = await client.query({ text: sql, values: params, rowMode: "array" });

      // Map field OIDs → decode categories, in column order.
      const categories = {};
      res.fields.forEach((f, i) => {
        categories[colPlan.columns[i]] = categoryForOid(f.dataTypeID);
      });

      // rowMode:"array" → each row is an array aligned to colPlan.columns.
      const lines = res.rows.map((arr) => {
        const obj = {};
        colPlan.columns.forEach((c, i) => (obj[c] = arr[i]));
        return JSON.stringify(encodeRow(obj, colPlan.columns));
      });
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
        columns: colPlan.columns,
        categories,
        stripped: colPlan.stripped,
        rowCount: res.rows.length,
      });
      grandTotal += res.rows.length;
      console.log(`export-org: ${plan.table.padEnd(28)} ${String(res.rows.length).padStart(7)} rows  [${plan.scope.kind}]`);
    }

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    await client.end();
    console.error(`export-org: FAILED — ${err?.stack ?? err}`);
    process.exit(1);
  }

  await client.end();

  const manifest = {
    kind: "cosmos-cutover-export",
    version: 1,
    orgId: org,
    stamp,
    exportedTableCount: manifestTables.length,
    totalRows: grandTotal,
    tables: manifestTables,
  };
  await writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.log(
    `\nexport-org: wrote ${grandTotal} rows across ${manifestTables.length} tables for org ${org}\n` +
      `  out:      ${out}\n` +
      `  manifest: ${path.join(out, "manifest.json")}`,
  );
}

main().catch((err) => {
  console.error(`export-org: unexpected error — ${err?.stack ?? err}`);
  process.exit(1);
});
