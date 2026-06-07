#!/usr/bin/env node
// scripts/cutover/acceptance/drop-table-from-dump.mjs
//
// SYNTHETIC-ACCEPTANCE helper for the parity-gate drift-B case. Produces a copy of a
// `pg_dump --schema-only` file that, once restored, is structurally SHORT one table —
// so `prisma migrate diff` against v2's datamodel is NON-EMPTY (the table needs to be
// re-created), exercising parity-gate part 1.
//
// Strategy: rather than surgically excising the (multi-line, dependency-tangled) CREATE
// TABLE + its indexes/FKs from the dump text — which is fragile — we APPEND a single
//   DROP TABLE IF EXISTS "<table>" CASCADE;
// to the END of the copy. The dump restores in full (every object created), then the
// trailing DROP removes the table and CASCADE cleans up anything that depended on it. The
// restored scratch DB is therefore missing exactly one table — a clean, deterministic drift.
//
// Usage: node drop-table-from-dump.mjs --in <dump.sql> --out <copy.sql> --table <name>

import { readFileSync, writeFileSync } from "node:fs";

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") o.in = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--table") o.table = argv[++i];
    else {
      console.error(`drop-table-from-dump: unknown arg ${a}`);
      process.exit(2);
    }
  }
  if (!o.in || !o.out || !o.table) {
    console.error("drop-table-from-dump: --in, --out and --table are required");
    process.exit(2);
  }
  // Guard the identifier so we only ever interpolate a plain table name.
  if (!/^[a-z_][a-z0-9_]*$/i.test(o.table)) {
    console.error(`drop-table-from-dump: unsafe table name ${o.table}`);
    process.exit(2);
  }
  return o;
}

const { in: inPath, out: outPath, table } = parseArgs(process.argv);
const dump = readFileSync(inPath, "utf8");
const drift =
  dump +
  `\n-- SYNTHETIC DRIFT (parity-gate acceptance): remove one table post-restore so` +
  `\n-- the restored snapshot is structurally short vs v2's datamodel.` +
  `\nDROP TABLE IF EXISTS "public"."${table}" CASCADE;\n`;
writeFileSync(outPath, drift);
console.error(`drop-table-from-dump: wrote ${outPath} with a trailing DROP TABLE ${table} CASCADE`);
