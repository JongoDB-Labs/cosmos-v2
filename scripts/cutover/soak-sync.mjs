#!/usr/bin/env node
// scripts/cutover/soak-sync.mjs — INCREMENTAL WATERMARK DELTA REPLAY (design spec §9.4).
//
//   Run under tsx; the TARGET url must be the DB OWNER (the import sets session_replication_role):
//     npx tsx scripts/cutover/soak-sync.mjs \
//       --source <SOURCE_DATABASE_URL> --target <OWNER_DATABASE_URL> \
//       --org <orgId> --state <state.json> [--loop --interval <sec>] [--stamp <iso>]
//
// ONE delta cycle:
//   1. load the per-table watermarks for --org from --state (a missing file/table = no
//      watermark = a FULL first sync of that table);
//   2. derive each migratable table's WATERMARK column (updated_at → created_at → none) from
//      the model-graph + the live source columns;
//   3. delta-export: the SHARED export core (lib/export-core.ts) runs the strict org-scope
//      SELECT with an extra `watermark_col > :last` filter ANDed in (so it can only NARROW,
//      never widen the org scope), PLUS the referential closure of any referenced parents (a
//      changed/new child pulls its global/shared-user parent in) — IDENTICAL to the full
//      export, just filtered;
//   4. idempotent import: the SHARED import core (lib/import-core.ts) UPSERTs the delta in one
//      owner transaction under session_replication_role = replica (append-only DO NOTHING;
//      mutable DO UPDATE WHERE EXCLUDED.updated_at > target) + the in-transaction orphan probe;
//   5. advance + persist the watermark per table to the MAX value OBSERVED in the exported
//      scoped rows (never a wall clock → no clock-skew window).
//
// DELETES are INVISIBLE to a watermark delta (a deleted source row simply stops appearing).
// That is BY DESIGN — soak-sync is an insert/update catch-up to keep the freeze window tiny.
// The FINAL reconcile (reconcile-org.mjs, run ONCE under freeze) is what removes deleted rows.
//
// `--loop --interval <sec>` repeats the cycle (the documented soak cadence). The interval/cron
// is OPS — this is the single-cycle unit wrapped in a sleep loop for convenience.
//
// BUILD-ONLY / SYNTHETIC-TEST ONLY. Never point --source/--target at production without the
// documented freeze + sign-off (docs/runbooks/cutover.md).
//
// `--stamp` is a CLI arg (Date.now() may be restricted under tsx); used only for the cycle log.

import { setupUtcTimestamps } from "./lib/pg-utc.ts";
// M1: force UTC + register the OID-1114 (timestamp without tz) parser BEFORE any pg/Date use, so
// the watermark round-trip is offset-free regardless of host TZ (no silently-skipped rows).
setupUtcTimestamps();

import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { buildModelPlans, resolveColumns } from "./lib/model-graph.ts";
import { collectOrgRows } from "./lib/export-core.ts";
import { importUnits } from "./lib/import-core.ts";
import {
  watermarkColumnFor,
  deltaWhereFragment,
  advanceWatermark,
  emptyState,
  watermarksForOrg,
  assertValidState,
} from "./lib/watermark.ts";

function parseArgs(argv) {
  const out = { loop: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") out.source = argv[++i];
    else if (a === "--target") out.target = argv[++i];
    else if (a === "--org") out.org = argv[++i];
    else if (a === "--state") out.state = argv[++i];
    else if (a === "--stamp") out.stamp = argv[++i];
    else if (a === "--loop") out.loop = true;
    else if (a === "--interval") out.interval = Number(argv[++i]);
    else {
      console.error(`soak-sync: unknown arg ${a}`);
      process.exit(2);
    }
  }
  return out;
}
function req(args, name) {
  if (!args[name]) {
    console.error(`soak-sync: missing required --${name}`);
    process.exit(2);
  }
  return args[name];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Load + validate the state file; a missing file = a fresh empty state (first sync). */
async function loadState(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return emptyState();
    throw e;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) return emptyState();
  const obj = JSON.parse(trimmed);
  assertValidState(obj);
  return obj;
}

/** Persist the state atomically (write a temp file then rename) so a crash can't corrupt it. */
async function saveState(path, state) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
}

/**
 * Derive the per-table watermark plan against the LIVE source schema (so we know which tables
 * actually have a created_at column). Returns Map<table, WatermarkPlan>.
 */
async function deriveWatermarkPlans(srcClient, plans) {
  const wmByTable = new Map();
  for (const plan of plans) {
    const cols = (await resolveColumns(srcClient, plan.model)).columns;
    const createdAtPresent = cols.includes("created_at");
    wmByTable.set(plan.table, watermarkColumnFor(plan, createdAtPresent));
  }
  return wmByTable;
}

/** Run exactly ONE delta cycle. Returns the per-cycle summary (scanned/upserted per table). */
async function runCycle(args, plans, wmByTable, stamp) {
  const org = args.org;
  const state = await loadState(args.state);
  const lastWatermarks = watermarksForOrg(state, org);

  // Build the per-table delta filters from the last watermarks. A null/absent last watermark or
  // a full-scan table (no watermark column) ⇒ no filter (full org-scope for that table).
  const deltaFilters = new Map();
  const watermarkColumns = new Map();
  for (const [table, wm] of wmByTable) {
    watermarkColumns.set(table, wm.column);
    const frag = deltaWhereFragment(wm, lastWatermarks[table], 2); // org scope is $1, delta is $2
    if (frag.sql) deltaFilters.set(table, { sql: frag.sql, value: frag.value });
  }

  // ── 1. delta-export (strict org-scope + watermark filter + referential closure) ──
  const src = new pg.Client({ connectionString: args.source });
  await src.connect();
  let collected;
  try {
    collected = await collectOrgRows(src, plans, org, {
      deltaFilters,
      watermarkColumns,
      log: (m) => console.log(m.replace(/^export-core:/, "soak-sync[export]:")),
    });
  } finally {
    await src.end();
  }

  // Build import units in plan order (so FK-friendly load order is preserved).
  const units = [];
  for (const plan of plans) {
    const st = collected.get(plan.table);
    units.push({
      model: plan.model,
      table: plan.table,
      columns: st.columns,
      categories: st.categories,
      rows: st.rows,
    });
  }

  // ── 2. idempotent import (one owner txn, replica role, orphan-probe backstop) ──
  const tgt = new pg.Client({ connectionString: args.target });
  await tgt.connect();
  let importSummary;
  try {
    importSummary = await importUnits(tgt, plans, org, units, {
      log: (m) => console.log(m.replace(/^import-core:/, "soak-sync[import]:")),
    });
  } finally {
    await tgt.end();
  }

  // ── 3. advance + persist watermarks (max observed in the scoped rows) ──
  const newWatermarks = { ...lastWatermarks };
  const perTable = [];
  for (const [table, wm] of wmByTable) {
    const st = collected.get(table);
    // Only the SCOPED rows drive the watermark (closure parents are excluded from advance).
    const advanced = advanceWatermark(wm, lastWatermarks[table], st.observedWatermarks);
    newWatermarks[table] = advanced;
    const r = importSummary.results.find((x) => x.table === table);
    perTable.push({
      table,
      watermarkColumn: wm.column,
      scanned: st.scopedCount,
      closure: st.closureCount,
      upserted: r ? r.inserted + r.updated : 0,
      inserted: r ? r.inserted : 0,
      updated: r ? r.updated : 0,
      newWatermark: advanced,
    });
  }
  state.orgs[org] = newWatermarks;
  await saveState(args.state, state);

  // ── per-cycle report ──
  const changed = perTable.filter((t) => t.scanned > 0 || t.upserted > 0);
  console.log(`\nsoak-sync: cycle @ ${stamp} — org ${org}`);
  for (const t of changed) {
    console.log(
      `soak-sync:   ${t.table.padEnd(28)} scanned=${String(t.scanned).padStart(6)} ` +
        `upserted=${String(t.upserted).padStart(6)} (ins ${t.inserted}/upd ${t.updated}) ` +
        `wm[${t.watermarkColumn ?? "FULL"}]=${t.newWatermark ?? "-"}`,
    );
  }
  const totalScanned = perTable.reduce((n, t) => n + t.scanned, 0);
  const totalUpserted = perTable.reduce((n, t) => n + t.upserted, 0);
  console.log(
    `soak-sync: cycle done — scanned ${totalScanned}, upserted ${totalUpserted}, ` +
      `dedupe drops ${importSummary.dedupDrops.length}, closure parents carried this cycle ` +
      `${perTable.reduce((n, t) => n + t.closure, 0)}`,
  );
  // Stable machine-readable line for acceptance to grep.
  console.log(
    `SOAK_SYNC_CYCLE ${JSON.stringify({ scanned: totalScanned, upserted: totalUpserted, inserted: importSummary.totals.inserted, updated: importSummary.totals.updated, dedupDrops: importSummary.dedupDrops.length })}`,
  );
  return { perTable, importSummary };
}

async function main() {
  const args = parseArgs(process.argv);
  req(args, "source");
  req(args, "target");
  req(args, "org");
  req(args, "state");
  if (!UUID_RE.test(args.org)) {
    console.error(`soak-sync: --org ${args.org} is not a UUID`);
    process.exit(2);
  }
  if (args.loop && (!args.interval || args.interval <= 0)) {
    console.error(`soak-sync: --loop requires a positive --interval <seconds>`);
    process.exit(2);
  }
  const stamp = args.stamp ?? "(no --stamp)";

  const plans = buildModelPlans();

  // Derive watermark plans ONCE against the live source schema (the schema is stable across a
  // soak; a re-derive per cycle would be wasted work).
  const src = new pg.Client({ connectionString: args.source });
  await src.connect();
  let wmByTable;
  try {
    wmByTable = await deriveWatermarkPlans(src, plans);
  } finally {
    await src.end();
  }
  const noWmTables = [...wmByTable.values()].filter((w) => w.column === null);
  if (noWmTables.length > 0) {
    console.log(
      `soak-sync: ${noWmTables.length} table(s) have no time column → FULL-SCAN every cycle ` +
        `(idempotent; can't miss a change): ${noWmTables.map((w) => w.table).join(", ")}`,
    );
  }

  if (!args.loop) {
    await runCycle(args, plans, wmByTable, stamp);
    return;
  }

  // Loop mode (the soak cadence). Each cycle is independent + fully persisted before the sleep,
  // so a kill between cycles loses nothing (the next run resumes from the persisted watermarks).
  console.log(`soak-sync: LOOP mode — every ${args.interval}s (Ctrl-C to stop)`);
  let stop = false;
  process.on("SIGINT", () => {
    console.log("\nsoak-sync: SIGINT — finishing the current sleep then exiting cleanly.");
    stop = true;
  });
  for (let cycle = 1; !stop; cycle++) {
    console.log(`\n──────── soak-sync cycle ${cycle} ────────`);
    try {
      await runCycle(args, plans, wmByTable, stamp);
    } catch (err) {
      // A transient error (e.g. source briefly unreachable) must NOT kill the soak; log + retry
      // next interval. The watermarks are only advanced on a SUCCESSFUL cycle, so a failed cycle
      // is simply retried in full — no row is skipped.
      console.error(`soak-sync: cycle ${cycle} FAILED (will retry next interval) — ${err?.stack ?? err}`);
    }
    if (stop) break;
    await sleep(args.interval * 1000);
  }
  console.log("soak-sync: loop stopped.");
}

main().catch((err) => {
  console.error(`soak-sync: unexpected error — ${err?.stack ?? err}`);
  process.exit(1);
});
