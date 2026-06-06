#!/usr/bin/env node
// scripts/cutover/verify-org.mjs — THE HARD FLIP GATE (design spec §9.3 step 7 / §9.4).
//
//   npx tsx scripts/cutover/verify-org.mjs --source <url> --target <url> --org <orgId> [--out report.json]
//
// Compares the SOURCE org (pre-cutover) against the TARGET v2 org (post-import) and FAILS
// (exit non-zero) on ANY mismatch. A clean report (exit 0) is the precondition for the flip.
//
// Checks:
//   1. PER-MODEL EXACT ROW-COUNT MATCH — source org-scoped count == target org-scoped count.
//      DataClassification is special: target == DEDUPED(source) (one ceiling per org), so the
//      expected target count is source_count − dedupe_drops. Mismatch ⇒ FAIL.
//   2. PER-ROW MONEY EQUALITY — for every Decimal money column, PK-join source↔target and
//      assert equality. Source Decimal ⇒ EXACT (normalized numeric string). Source Float ⇒
//      target == round(source, 4). NEVER an aggregate SUM (float summation isn't byte-stable).
//   3. CUI/FOUO MARKING INVARIANT — count of orgs bearing ANY CUI/FOUO marking: source==target
//      (markings carried verbatim; the dedupe keeps the highest level + its markings).
//   4. SAMPLED CONTENT CHECKSUM — a per-row sha256 over a sample of MUTABLE rows must match,
//      catching silent corruption that a count alone would miss.
//
// BUILD-ONLY / SYNTHETIC-TEST ONLY (read-only on both DBs).

import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
import { buildModelPlans, resolveColumns, buildScopedSelect, rankOf } from "./lib/model-graph.ts";
import { encodeValue } from "./lib/ndjson-codec.ts";
import { dedupeClassifications } from "./lib/upsert.ts";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") out.source = argv[++i];
    else if (a === "--target") out.target = argv[++i];
    else if (a === "--org") out.org = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else {
      console.error(`verify-org: unknown arg ${a}`);
      process.exit(2);
    }
  }
  return out;
}
function req(args, name) {
  if (!args[name]) {
    console.error(`verify-org: missing required --${name}`);
    process.exit(2);
  }
  return args[name];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PG type OID for numeric/decimal. A money column whose source OID is NUMERIC is compared
// EXACTLY; anything else (a Float8/Float4 source, OIDs 701/700) is compared as
// target == round(source, 4) — the only two shapes a money column can take across the v1→v2
// type boundary.
const OID_NUMERIC = 1700;

// Normalize a numeric string to a canonical form so "10.5" == "10.5000" == "10.50".
// Both v1-Decimal and v2-Decimal arrive as numeric strings; this makes the EXACT compare
// tolerant of trailing-zero scale differences ONLY (never of an actual value difference).
function normalizeNumericString(s) {
  if (s === null || s === undefined) return null;
  let str = String(s).trim();
  let neg = false;
  if (str.startsWith("-")) {
    neg = true;
    str = str.slice(1);
  } else if (str.startsWith("+")) {
    str = str.slice(1);
  }
  let [intPart, fracPart = ""] = str.split(".");
  intPart = intPart.replace(/^0+(?=\d)/, ""); // strip leading zeros, keep one
  fracPart = fracPart.replace(/0+$/, ""); // strip trailing zeros
  if (intPart === "") intPart = "0";
  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  return neg && out !== "0" ? `-${out}` : out;
}

// Compare one money value: source (Decimal-string OR Float-number) vs target Decimal-string.
function moneyEqual(srcVal, srcOid, tgtVal) {
  if (srcVal === null && tgtVal === null) return true;
  if (srcVal === null || tgtVal === null) return false;
  if (srcOid === OID_NUMERIC) {
    // Decimal ⇒ exact (scale-normalized).
    return normalizeNumericString(srcVal) === normalizeNumericString(tgtVal);
  }
  // Float source ⇒ target must equal round(source, 4).
  const rounded = normalizeNumericString(Number(srcVal).toFixed(4));
  return rounded === normalizeNumericString(tgtVal);
}

async function scopedCount(client, plan, org) {
  // Reuse the scoped SELECT but only fetch the PK to count org-scoped rows.
  const { sql, params } = buildScopedSelect(plan, [plan.pk[0]], org);
  const res = await client.query({ text: sql, values: params });
  return res.rowCount;
}

async function fetchScopedRows(client, plan, columns, org) {
  const { sql, params } = buildScopedSelect(plan, columns, org);
  const res = await client.query({ text: sql, values: params });
  return { rows: res.rows, fields: res.fields };
}

// Orgs bearing any CUI/FOUO marking — by LEVEL (CUI/FOUO) OR a marking string containing
// CUI/FOUO. Scoped to this org (we verify ONE tenant), so the count is 0 or 1.
async function cuiFouoOrgCount(client, org) {
  const { rows } = await client.query(
    `SELECT count(DISTINCT org_id)::int AS n
       FROM data_classifications
      WHERE org_id = $1
        AND ( level IN ('CUI','FOUO')
              OR EXISTS (SELECT 1 FROM unnest(markings) m
                          WHERE upper(m) LIKE '%CUI%' OR upper(m) LIKE '%FOUO%') )`,
    [org],
  );
  return rows[0].n;
}

async function main() {
  const args = parseArgs(process.argv);
  const source = req(args, "source");
  const target = req(args, "target");
  const org = req(args, "org");
  if (!UUID_RE.test(org)) {
    console.error(`verify-org: --org ${org} is not a UUID`);
    process.exit(2);
  }

  const src = new pg.Client({ connectionString: source });
  const tgt = new pg.Client({ connectionString: target });
  await src.connect();
  await tgt.connect();

  const plans = buildModelPlans();
  const report = {
    kind: "cosmos-cutover-verify",
    orgId: org,
    checkedAt: new Date().toISOString(),
    counts: [],
    money: [],
    markings: null,
    checksums: [],
    mismatches: [],
    clean: false,
  };

  try {
    for (const plan of plans) {
      // Use the SOURCE column list as the comparison basis (target shares the schema).
      const srcCols = (await resolveColumns(src, plan.model)).columns;
      const tgtCols = (await resolveColumns(tgt, plan.model)).columns;
      // Intersect so a benign extra/missing column on one side doesn't break the join.
      const cols = srcCols.filter((c) => tgtCols.includes(c));

      // ── 1. Counts ──
      const srcCount = await scopedCount(src, plan, org);
      const tgtCount = await scopedCount(tgt, plan, org);

      let expectedTgt = srcCount;
      let note = "";
      // Source PKs that are EXPECTED to be absent from the target (only DataClassification
      // drops any — the dedupe-with-audit collapses duplicate org-ceiling rows). The money
      // + checksum checks skip these so a deliberately-dropped row isn't flagged "missing".
      const droppedPkSet = new Set();
      if (plan.model === "DataClassification") {
        // Run the SAME dedupe the import ran to learn exactly which source rows survive.
        const { rows } = await src.query(
          `SELECT id, org_id, project_id, level, markings, handling_instructions FROM data_classifications WHERE org_id = $1`,
          [org],
        );
        const { drops } = dedupeClassifications(rows, rankOf);
        for (const d of drops) droppedPkSet.add(d.droppedId);
        expectedTgt = srcCount - drops.length;
        note = `deduped: ${drops.length} duplicate ceiling row(s) dropped`;
      }

      const countOk = tgtCount === expectedTgt;
      report.counts.push({ table: plan.table, source: srcCount, target: tgtCount, expectedTarget: expectedTgt, ok: countOk, note });
      if (!countOk) {
        report.mismatches.push(
          `count ${plan.table}: target ${tgtCount} != expected ${expectedTgt} (source ${srcCount})`,
        );
      }

      // ── 2. Per-row money equality ──
      if (plan.moneyColumns.length > 0) {
        const sres = await fetchScopedRows(src, plan, cols, org);
        const tres = await fetchScopedRows(tgt, plan, cols, org);
        // Map money column → source OID (to know Decimal vs Float).
        const srcMoneyOid = {};
        sres.fields.forEach((f, i) => {
          if (plan.moneyColumns.includes(cols[i])) srcMoneyOid[cols[i]] = f.dataTypeID;
        });
        const tgtByPk = new Map(tres.rows.map((r) => [r[plan.pk[0]], r]));
        let checked = 0;
        let bad = 0;
        for (const sr of sres.rows) {
          if (droppedPkSet.has(sr[plan.pk[0]])) continue; // deduped away — not expected in target
          const tr = tgtByPk.get(sr[plan.pk[0]]);
          for (const mc of plan.moneyColumns) {
            checked++;
            if (!tr) {
              bad++;
              report.mismatches.push(`money ${plan.table}.${mc}: source row ${sr[plan.pk[0]]} missing in target`);
              continue;
            }
            if (!moneyEqual(sr[mc], srcMoneyOid[mc], tr[mc])) {
              bad++;
              report.mismatches.push(
                `money ${plan.table}.${mc} row ${sr[plan.pk[0]]}: source ${JSON.stringify(sr[mc])} != target ${JSON.stringify(tr[mc])}`,
              );
            }
          }
        }
        report.money.push({ table: plan.table, columns: plan.moneyColumns, checked, mismatches: bad, ok: bad === 0 });
      }

      // ── 4. Sampled content checksum (mutable rows) ──
      if (!plan.appendOnly && tgtCount > 0) {
        const sres = await fetchScopedRows(src, plan, cols, org);
        const tres = await fetchScopedRows(tgt, plan, cols, org);
        const tgtByPk = new Map(tres.rows.map((r) => [r[plan.pk[0]], r]));
        // Sample up to 25 rows by PK order (deterministic), excluding any deduped-away rows.
        const sample = sres.rows.filter((r) => !droppedPkSet.has(r[plan.pk[0]])).slice(0, 25);
        let bad = 0;
        for (const sr of sample) {
          const tr = tgtByPk.get(sr[plan.pk[0]]);
          if (!tr) {
            bad++;
            report.mismatches.push(`checksum ${plan.table}: source row ${sr[plan.pk[0]]} missing in target`);
            continue;
          }
          if (rowChecksum(sr, cols) !== rowChecksum(tr, cols)) {
            bad++;
            report.mismatches.push(`checksum ${plan.table} row ${sr[plan.pk[0]]}: content differs`);
          }
        }
        report.checksums.push({ table: plan.table, sampled: sample.length, mismatches: bad, ok: bad === 0 });
      }
    }

    // ── 3. CUI/FOUO marking invariant ──
    const srcMark = await cuiFouoOrgCount(src, org);
    const tgtMark = await cuiFouoOrgCount(tgt, org);
    report.markings = { source: srcMark, target: tgtMark, ok: srcMark === tgtMark };
    if (srcMark !== tgtMark) {
      report.mismatches.push(`CUI/FOUO marking invariant: source ${srcMark} != target ${tgtMark} org(s)`);
    }
  } catch (err) {
    await src.end();
    await tgt.end();
    console.error(`verify-org: FAILED — ${err?.stack ?? err}`);
    process.exit(1);
  }

  await src.end();
  await tgt.end();

  report.clean = report.mismatches.length === 0;

  if (args.out) await writeFile(args.out, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));

  if (report.clean) {
    console.error(`\nverify-org: CLEAN — org ${org} verified (counts, per-row money, markings, checksums). Flip GATE PASSED.`);
    process.exit(0);
  }
  console.error(`\nverify-org: MISMATCH — ${report.mismatches.length} problem(s). Flip GATE FAILED. Do NOT flip.`);
  for (const m of report.mismatches) console.error(`  - ${m}`);
  process.exit(1);
}

// Deterministic per-row checksum over the shared columns (type-normalized via the codec).
function rowChecksum(row, columns) {
  const norm = {};
  for (const c of columns) norm[c] = encodeValue(row[c]);
  return createHash("sha256").update(JSON.stringify(norm)).digest("hex");
}

main().catch((err) => {
  console.error(`verify-org: unexpected error — ${err?.stack ?? err}`);
  process.exit(1);
});
