#!/usr/bin/env node
// scripts/cutover/import-org.mjs — PER-TENANT IDEMPOTENT IMPORT / REPLAY (design spec §9.3-9.4).
//
//   Run under tsx AS THE DB OWNER (it needs session_replication_role + full DML):
//     npx tsx scripts/cutover/import-org.mjs \
//       --target <OWNER_DATABASE_URL> --in <export-dir> --org <orgId>
//
// One transaction, FK-safe bulk load:
//   BEGIN;
//   SET LOCAL session_replication_role = replica;   -- suppress FK + user triggers
//   <per table, in manifest order: idempotent UPSERT per row>
//   <DataClassification: dedupe-with-audit, then UPSERT the survivors>
//   COMMIT;                                          -- session_replication_role auto-resets
//
// WHY session_replication_role = replica:
//   - FK constraints are enforced by triggers; `replica` suppresses them, so the multi-table
//     load doesn't need a perfect topological order (the COMPLETE set is consistent at commit).
//   - It ALSO suppresses the audit append-only + hash-chain BEFORE-INSERT triggers. Imported
//     audit_logs / egress_decisions rows therefore arrive with NULL row_hash — which
//     verify_audit_chain() treats as PRE-CHAIN LEGACY (it scopes the chain to row_hash IS NOT
//     NULL). This is CONSISTENT + INTENDED: the migrated history is anchored by the SOURCE's
//     own offsite WORM export, not re-chained on import. New post-cutover rows chain normally.
//   - SET LOCAL scopes it to THIS transaction; it resets at COMMIT/ROLLBACK automatically.
//
// IDEMPOTENT: append-only ⇒ ON CONFLICT DO NOTHING; mutable ⇒ DO UPDATE only when
// EXCLUDED.updated_at > target.updated_at. A second run with an unchanged source = 0/0.
//
// BUILD-ONLY / SYNTHETIC-TEST ONLY. Never point --target at a production database without
// the documented runbook + sign-off (docs/runbooks/cutover.md).

import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { buildModelPlans } from "./lib/model-graph.ts";
import { rankOf } from "./lib/model-graph.ts";
import { decodeRow } from "./lib/ndjson-codec.ts";
import { buildUpsert, dedupeClassifications } from "./lib/upsert.ts";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") out.target = argv[++i];
    else if (a === "--in") out.in = argv[++i];
    else if (a === "--org") out.org = argv[++i];
    else {
      console.error(`import-org: unknown arg ${a}`);
      process.exit(2);
    }
  }
  return out;
}
function req(args, name) {
  if (!args[name]) {
    console.error(`import-org: missing required --${name}`);
    process.exit(2);
  }
  return args[name];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseNdjson(text) {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

async function main() {
  const args = parseArgs(process.argv);
  const target = req(args, "target");
  const inDir = req(args, "in");
  const org = req(args, "org");
  if (!UUID_RE.test(org)) {
    console.error(`import-org: --org ${org} is not a UUID`);
    process.exit(2);
  }

  const manifest = JSON.parse(await readFile(path.join(inDir, "manifest.json"), "utf8"));
  if (manifest.orgId !== org) {
    console.error(
      `import-org: REFUSING — manifest orgId ${manifest.orgId} != --org ${org}. ` +
        `Org-scope mismatch; aborting to avoid writing the wrong tenant.`,
    );
    process.exit(2);
  }

  // Cross-check the export manifest against the LIVE plan so a schema drift between export
  // and import is caught loudly (a table in the manifest we no longer migrate, or vice versa).
  const planByModel = new Map(buildModelPlans().map((p) => [p.model, p]));

  const client = new pg.Client({ connectionString: target });
  await client.connect();

  const results = []; // per-table { table, inserted, updated, skipped }
  let dedupDrops = [];
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  try {
    await client.query("BEGIN");
    // Confirm we're the owner / can set session_replication_role; this throws for cosmos_app.
    await client.query("SET LOCAL session_replication_role = replica");

    for (const t of manifest.tables) {
      const plan = planByModel.get(t.model);
      if (!plan) {
        throw new Error(
          `import-org: manifest table ${t.table} (${t.model}) is not a migratable model in the current schema — aborting`,
        );
      }

      const ndjsonPath = path.join(inDir, t.file);
      let rows;
      try {
        rows = parseNdjson(await readFile(ndjsonPath, "utf8"));
      } catch (e) {
        if (e?.code === "ENOENT") rows = [];
        else throw e;
      }

      // DataClassification: dedupe-with-audit BEFORE inserting (one ceiling per org).
      let importRows = rows;
      if (plan.model === "DataClassification") {
        const { kept, drops } = dedupeClassifications(rows, rankOf);
        importRows = kept;
        dedupDrops = drops;
        for (const d of drops) {
          console.log(
            `import-org: DataClassification DEDUPE — org ${d.orgId} ceiling: keep ${d.keptLevel} (${d.keptId}), ` +
              `drop ${d.droppedLevel} (${d.droppedId})${d.droppedMarkings.length ? ` [dropped markings: ${d.droppedMarkings.join(", ")}]` : ""}`,
          );
        }
      }

      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      for (const row of importRows) {
        // Strict org-scope re-assertion on rows that carry an org_id: never write a row
        // belonging to another org, even if the export somehow contained one. (MEMBER-scoped
        // Users carry no org_id; the ROOT Organization row's id == org and is checked below.)
        if ("org_id" in row && row.org_id !== null && row.org_id !== org) {
          throw new Error(
            `import-org: row in ${t.table} has org_id ${row.org_id} != ${org} — refusing cross-org write`,
          );
        }
        if (plan.scope.kind === "ROOT" && row.id !== org) {
          throw new Error(
            `import-org: organizations row id ${row.id} != ${org} — refusing cross-org write`,
          );
        }
        const values = decodeRow(row, t.columns, t.categories);
        const stmt = buildUpsert(plan, t.columns, values);
        const r = await client.query(stmt.sql, stmt.params);
        // RETURNING (xmax = 0) AS __inserted: a returned row means a real write —
        // __inserted true ⇒ INSERT, false ⇒ UPDATE. No returned row ⇒ conflict skipped.
        if (r.rowCount === 0) {
          skipped++;
        } else if (r.rows[0].__inserted === true) {
          inserted++;
        } else {
          updated++;
        }
      }

      results.push({ table: t.table, model: t.model, rowsInFile: rows.length, inserted, updated, skipped });
      console.log(
        `import-org: ${t.table.padEnd(28)} +${String(inserted).padStart(6)} ~${String(updated).padStart(6)} =${String(skipped).padStart(6)} (skipped)`,
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    await client.end();
    console.error(`import-org: FAILED — ${err?.stack ?? err}`);
    process.exit(1);
  }
  await client.end();

  for (const r of results) {
    totalInserted += r.inserted;
    totalUpdated += r.updated;
    totalSkipped += r.skipped;
  }

  const summary = {
    kind: "cosmos-cutover-import",
    orgId: org,
    stamp: manifest.stamp,
    totals: { inserted: totalInserted, updated: totalUpdated, skipped: totalSkipped },
    dedupDrops,
    tables: results,
  };
  console.log("\n" + JSON.stringify(summary, null, 2));
  console.log(
    `\nimport-org: org ${org} — inserted ${totalInserted}, updated ${totalUpdated}, skipped ${totalSkipped}, ` +
      `classification drops ${dedupDrops.length}`,
  );
}

main().catch((err) => {
  console.error(`import-org: unexpected error — ${err?.stack ?? err}`);
  process.exit(1);
});
