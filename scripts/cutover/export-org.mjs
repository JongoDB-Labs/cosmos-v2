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
import {
  buildModelPlans,
  resolveColumns,
  buildScopedSelect,
  fkEdgesOf,
  quoteIdent,
} from "./lib/model-graph.ts";
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
  const planByModel = new Map(plans.map((p) => [p.model, p]));
  const planByTable = new Map(plans.map((p) => [p.table, p]));

  // Per-table accumulated state, so the closure pass can append rows + re-scan for new refs
  // before we write the NDJSON files. Keyed by physical table.
  //   rows       : encoded-row objects (column→encoded value), in insertion order
  //   ids        : Set of exported single-PK ids (closure dedupe; composite-PK tables don't
  //                participate as closure TARGETS — only User/globals are targets here)
  //   columns    : the resolved copyable column list
  //   categories : column→PgTypeCategory
  //   pk         : single PK column (for closure id tracking)
  //   scopedCount: rows from the strict org-scope (before closure) — reported in the manifest
  const state = new Map();

  let grandTotal = 0;

  try {
    // Read-only, repeatable snapshot for a self-consistent multi-table export.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

    // ── Phase 1: strict org-scoped export of every migratable model ──
    for (const plan of plans) {
      const colPlan = await resolveColumns(client, plan.model);
      const { sql, params } = buildScopedSelect(plan, colPlan.columns, org);
      const res = await client.query({ text: sql, values: params, rowMode: "array" });

      // Map field OIDs → decode categories, in column order.
      const categories = {};
      res.fields.forEach((f, i) => {
        categories[colPlan.columns[i]] = categoryForOid(f.dataTypeID);
      });

      const pkCol = plan.pk[0];
      const ids = new Set();
      const rows = res.rows.map((arr) => {
        const obj = {};
        colPlan.columns.forEach((c, i) => (obj[c] = arr[i]));
        if (plan.pk.length === 1 && obj[pkCol] != null) ids.add(obj[pkCol]);
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
      });
      console.log(
        `export-org: ${plan.table.padEnd(28)} ${String(rows.length).padStart(7)} rows  [${plan.scope.kind}]`,
      );
    }

    // ── Phase 2: REFERENTIAL CLOSURE — pull referenced parent rows the strict scope missed ──
    //
    // Iterate to a FIXPOINT: each pass collects, per target table, the distinct non-null FK
    // values referenced by rows already in `state` but NOT yet exported into that target
    // table; fetches those parent rows BY ID (no org filter); appends them; repeats until a
    // pass adds nothing. The org-scope SELECTs are NOT touched — this only ADDS referenced
    // parents (users/globals), never widening the org's own business data.
    let closureAdded = 0;
    for (let pass = 1; ; pass++) {
      // target table → Set of ids we need but don't yet have
      const want = new Map();
      for (const [, st] of state) {
        const edges = fkEdgesOf(st.model);
        if (edges.length === 0) continue;
        for (const e of edges) {
          const target = state.get(e.targetTable);
          // Closure only follows targets we actually migrate (have a plan/state for).
          if (!target) continue;
          for (const row of st.rows) {
            const v = row[e.fkColumn];
            if (v == null) continue;
            if (target.ids.has(v)) continue; // already exported (org-scoped or earlier pass)
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

        // Fetch the referenced parent rows BY ID — regardless of org_id / membership. This is
        // the ONLY non-org-strict read in the exporter, and it is BOUNDED to exactly the ids a
        // migrated child references (a global built-in or a shared user). It can NEVER pull
        // another org's BUSINESS rows: only a row whose id is referenced by THIS org's data,
        // and such parents are shared-by-design (users, global templates).
        const t = quoteIdent(table);
        const cols = st.columns.map((c) => `${t}.${quoteIdent(c)}`).join(", ");
        const idCol = quoteIdent(st.pk);
        const { rows: parentRows } = await client.query({
          text: `SELECT ${cols} FROM ${t} WHERE ${t}.${idCol} = ANY($1::uuid[]) ORDER BY ${t}.${idCol} ASC`,
          values: [ids],
          rowMode: "array",
        });

        for (const arr of parentRows) {
          const obj = {};
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
      console.log(
        `export-org: closure pass ${pass}: +${addedThisPass} referenced parent row(s)` +
          (addedThisPass === 0 ? " (fixpoint reached)" : ""),
      );
      if (addedThisPass === 0) break;
    }
    if (closureAdded > 0) {
      console.log(`export-org: referential closure added ${closureAdded} shared parent row(s) total`);
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
