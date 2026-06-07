#!/usr/bin/env node
// scripts/cutover/parity-gate.mjs — CUTOVER SCHEMA-PARITY + PROVENANCE HARD GATE (§9.2).
//
//   Run under tsx (imports the .ts pure helpers):
//     npx tsx scripts/cutover/parity-gate.mjs \
//       --prod-schema-dump <path.sql>   (a `pg_dump --schema-only` of the live prod DB) \
//       --scratch-url      <url>        (a THROWAWAY Postgres to restore the dump into) \
//       --stamp            <iso8601>    (the check timestamp — a CLI arg on purpose) \
//       [--prod-migrations <path>]      (prod's _prisma_migrations rows: JSON or psql CSV) \
//       [--prod-commit     <sha>]       (the prod git commit the dump was taken at) \
//       [--out             <path>]      (provenance output; default compliance/provenance/prod-baseline.json) \
//       [--no-write]                    (run the gate but do NOT write the provenance file)
//
// THE TWO-PART HARD GATE (both must pass or the script exits NON-ZERO — fail closed):
//
//   Gate part 1 — PARITY: `prisma migrate diff` between the RESTORED prod snapshot (the
//     scratch DB) and v2's prisma/schema.prisma datamodel must be EMPTY. A non-empty diff
//     means v2's model is NOT structurally identical to what prod actually runs — the
//     cutover would migrate into an unproven schema. On drift the diff SQL is captured.
//
//   Gate part 2 — CLASSIFICATION FK: the restored snapshot must carry a FOREIGN KEY
//     data_classifications.project_id -> projects.id. Its presence proves the baseline was
//     reconciled from the classification-propagation line (per-project classification), not
//     an older branch. Missing ⇒ FAIL.
//
// Then PROVENANCE: a stable sha256 over prod's ordered (migration_name, checksum) history
// + the prod commit + the gate verdict is written to compliance/provenance/prod-baseline.json
// so the cutover's source-of-truth is auditable.
//
// BUILD-ONLY / SYNTHETIC-TEST ONLY. This script is RUN against a RESTORED prod snapshot in
// a scratch DB, NEVER against live prod. The dump + the _prisma_migrations export are
// captured out-of-band (see docs/runbooks/cutover.md "Step 0"). It only WRITES to the
// throwaway scratch DB + the provenance file.
//
// FAIL-CLOSED: any error (bad args, restore failure, missing extension, diff engine error,
// probe error) exits non-zero. The gate NEVER passes on ambiguity.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  parseMigrationRows,
  classificationFkProbeSql,
  buildBaselineRecord,
  CLASSIFICATION_FK,
} from "./lib/parity-lib.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "prisma", "schema.prisma");
const DEFAULT_OUT = path.join(REPO_ROOT, "compliance", "provenance", "prod-baseline.json");

function parseArgs(argv) {
  const out = { write: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prod-schema-dump") out.dump = argv[++i];
    else if (a === "--prod-migrations") out.migrations = argv[++i];
    else if (a === "--prod-commit") out.commit = argv[++i];
    else if (a === "--scratch-url") out.scratch = argv[++i];
    else if (a === "--stamp") out.stamp = argv[++i];
    else if (a === "--out") out.outPath = argv[++i];
    else if (a === "--no-write") out.write = false;
    else {
      fail(`parity-gate: unknown arg ${a}`);
    }
  }
  return out;
}

/** Fail closed: print to stderr and exit non-zero. */
function fail(msg, code = 2) {
  console.error(`parity-gate: ${msg}`);
  process.exit(code);
}

function req(args, name, flag) {
  if (!args[name]) fail(`missing required --${flag}`);
  return args[name];
}

/** Run psql against the scratch URL, piping `sql` on stdin. Returns trimmed stdout. */
function psql(scratchUrl, sql, { allowFail = false } = {}) {
  const r = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-d", scratchUrl], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) fail(`psql spawn failed: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    fail(`psql exited ${r.status}: ${(r.stderr || "").slice(0, 4000)}`);
  }
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: r.stderr || "" };
}

/** Restore a pg_dump --schema-only file into the scratch DB via psql. */
function restoreDump(scratchUrl, dumpPath) {
  const sql = readFileSync(dumpPath, "utf8");
  // The dump may already CREATE EXTENSION; we pre-ensure pgcrypto+vector so a dump that
  // assumes they exist (or one we generated without them) restores cleanly either way.
  const r = spawnSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", "-d", scratchUrl], {
    input: sql,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.error) fail(`psql restore spawn failed: ${r.error.message}`);
  if (r.status !== 0) {
    fail(`schema dump restore FAILED (psql exit ${r.status}):\n${(r.stderr || "").slice(0, 8000)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const dump = req(args, "dump", "prod-schema-dump");
  const scratch = req(args, "scratch", "scratch-url");
  const stamp = req(args, "stamp", "stamp");
  const outPath = args.outPath ? path.resolve(args.outPath) : DEFAULT_OUT;

  if (!existsSync(dump)) fail(`--prod-schema-dump not found: ${dump}`);
  if (args.migrations && !existsSync(args.migrations)) {
    fail(`--prod-migrations not found: ${args.migrations}`);
  }
  // Reject an obvious live-prod URL guard is the operator's job; we only require a URL.
  if (!/^postgres(ql)?:\/\//.test(scratch)) {
    fail(`--scratch-url must be a postgres:// URL (got ${scratch})`);
  }

  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  CUTOVER SCHEMA-PARITY + PROVENANCE HARD GATE (§9.2)");
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  prod schema dump : ${dump}`);
  console.log(`  scratch DB       : ${redactUrl(scratch)}`);
  console.log(`  checkedAt (stamp): ${stamp}`);
  console.log(`  prod commit      : ${args.commit ?? "(not provided)"}`);
  console.log(`  prod migrations  : ${args.migrations ?? "(not provided)"}`);
  console.log("");

  // ── Step 1: ensure extensions + restore the dump into scratch ──────────────────────
  console.log("── Step 1: ensure pgcrypto+pgvector, restore prod schema dump into scratch ──");
  // pgcrypto (gen_random_uuid defaults) + vector (the embedding columns) must exist BEFORE
  // the dump's CREATE TABLE ... vector(384) / DEFAULT gen_random_uuid() statements run.
  psql(scratch, "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS vector;");
  restoreDump(scratch, dump);
  console.log("    restore OK.\n");

  // ── Step 2: gate part 1 — migrate diff parity ──────────────────────────────────────
  console.log("── Step 2: gate part 1 — prisma migrate diff (scratch ⟶ v2 datamodel) ──");
  const diff = runMigrateDiff(scratch);
  let parityPass;
  if (diff.exitCode === 0) {
    parityPass = true;
    console.log("    PASS — migrate diff is EMPTY (structural parity with v2's model).\n");
  } else if (diff.exitCode === 2) {
    parityPass = false;
    console.log("    FAIL — migrate diff is NON-EMPTY (v2's model differs from prod's schema).");
    console.log("    ── captured diff (scratch ⟶ v2 datamodel) ──");
    console.log(indent(diff.script || "(empty diff script)"));
    console.log("");
  } else {
    fail(`prisma migrate diff errored (exit ${diff.exitCode}):\n${diff.stderr.slice(0, 4000)}`, 2);
  }

  // ── Step 3: gate part 2 — classification FK assertion ──────────────────────────────
  console.log("── Step 3: gate part 2 — assert classification FK in the restored snapshot ──");
  const fkPass = await probeClassificationFk(scratch);
  if (fkPass) {
    console.log(
      `    PASS — FK ${CLASSIFICATION_FK.table}.${CLASSIFICATION_FK.column} -> ` +
        `${CLASSIFICATION_FK.refTable}.${CLASSIFICATION_FK.refColumn} EXISTS.\n`,
    );
  } else {
    console.log(
      `    FAIL — FK ${CLASSIFICATION_FK.table}.${CLASSIFICATION_FK.column} -> ` +
        `${CLASSIFICATION_FK.refTable}.${CLASSIFICATION_FK.refColumn} is MISSING ` +
        "(snapshot is NOT the reconciled classification baseline).\n",
    );
  }

  // ── Step 4: provenance ─────────────────────────────────────────────────────────────
  console.log("── Step 4: provenance ──");
  let migrationRows = null;
  if (args.migrations) {
    try {
      migrationRows = parseMigrationRows(readFileSync(args.migrations, "utf8"));
    } catch (e) {
      fail(`could not parse --prod-migrations: ${e.message}`);
    }
  }
  const record = buildBaselineRecord({
    prodCommit: args.commit ?? null,
    migrationRows,
    parityGate: parityPass && fkPass ? "pass" : "fail",
    classificationFk: fkPass,
    checkedAt: stamp,
  });

  if (args.write) {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
    console.log(`    provenance written: ${outPath}`);
  } else {
    console.log("    provenance NOT written (--no-write).");
  }
  console.log(`    migrationHistoryHash: ${record.migrationHistoryHash ?? "(no migrations export)"}`);
  console.log(`    migrationCount      : ${record.migrationCount ?? "(no migrations export)"}`);
  console.log(`    prodCommit          : ${record.prodCommit ?? "(not provided)"}`);
  console.log("");

  // ── Final verdict — fail closed ────────────────────────────────────────────────────
  const verdict = parityPass && fkPass;
  console.log("══════════════════════════════════════════════════════════════════════");
  console.log(`  PARITY GATE RESULT: ${verdict ? "PASS ✅" : "FAIL ❌"}`);
  console.log(`    part 1 (migrate diff empty) : ${parityPass ? "PASS" : "FAIL"}`);
  console.log(`    part 2 (classification FK)  : ${fkPass ? "PASS" : "FAIL"}`);
  console.log("══════════════════════════════════════════════════════════════════════");

  // Structured machine-readable line for harnesses.
  console.log(
    "PARITY_GATE_RESULT " +
      JSON.stringify({
        result: verdict ? "pass" : "fail",
        parityDiffEmpty: parityPass,
        classificationFk: fkPass,
        migrationHistoryHash: record.migrationHistoryHash,
        migrationCount: record.migrationCount,
        prodCommit: record.prodCommit,
        checkedAt: record.checkedAt,
      }),
  );

  process.exit(verdict ? 0 : 1);
}

/**
 * Run `prisma migrate diff --from-url <scratch> --to-schema-datamodel schema --exit-code`.
 * Exit-code contract (Prisma): 0 = empty (parity), 2 = non-empty (drift), 1 = error.
 * On drift we re-run with --script (no --exit-code) to capture the human/SQL diff text.
 *
 * NOTE on flag choice: the plan wrote `--from-schema-datasource <scratch-url>`, but that
 * Prisma flag takes a SCHEMA FILE path (it reads the datasource URL from the file), not a
 * raw URL. `--from-url <scratch-url>` is the direct, equivalent form for "diff this live DB
 * against v2's datamodel" — documented deviation, same semantics.
 */
function runMigrateDiff(scratchUrl) {
  const base = [
    "prisma",
    "migrate",
    "diff",
    "--from-url",
    scratchUrl,
    "--to-schema-datamodel",
    SCHEMA_PATH,
  ];
  const r = spawnSync("npx", [...base, "--exit-code"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
  if (r.error) fail(`prisma migrate diff spawn failed: ${r.error.message}`);
  const exitCode = r.status;
  let script = "";
  if (exitCode === 2) {
    // Capture the drift as a SQL script (does not write anything; read-only).
    const s = spawnSync("npx", [...base, "--script"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env },
    });
    script = (s.stdout || "").trim();
  }
  return { exitCode, script, stderr: r.stderr || "" };
}

/** Run the classification-FK probe SQL against scratch; returns true iff the FK exists. */
async function probeClassificationFk(scratchUrl) {
  const client = new pg.Client({ connectionString: scratchUrl });
  await client.connect();
  try {
    const res = await client.query(classificationFkProbeSql(CLASSIFICATION_FK));
    return res.rows[0]?.fk_exists === true;
  } finally {
    await client.end();
  }
}

function indent(s) {
  return s
    .split("\n")
    .map((l) => "      " + l)
    .join("\n");
}

/** Hide credentials in logged URLs. */
function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url;
  }
}

main().catch((e) => {
  fail(`unexpected error: ${e?.stack || e}`, 2);
});
