#!/usr/bin/env node
// scripts/cutover/snapshot-capture.mjs — PRE-FLIP RESTORE-POINT CAPTURE (design spec §9.4).
//
//   Run under tsx (it imports the .ts pure helpers); the --db url must be the DB OWNER /
//   a role that may call pg_create_restore_point (superuser or pg_checkpoint):
//
//     npx tsx scripts/cutover/snapshot-capture.mjs \
//       --db <OWNER_DATABASE_URL> --label <restore-point-name> \
//       --stamp <iso8601> --state <state.json> \
//       [--stanza cosmos] \
//       [--pgbackrest-exec '<cmd…>']   (a command that runs pgBackRest against the SAME cluster;
//                                       e.g. "sudo docker compose exec -T -u postgres cosmos-postgres".
//                                       When given, an incr backup is triggered + its label recorded.
//                                       When ABSENT, the backup step is SKIPPED — the named restore
//                                       point + LSN/time alone is the PITR target, recorded anyway.)
//       [--no-backup]                  (force-skip the incr backup even if --pgbackrest-exec is set)
//
// WHAT IT DOES (read-mostly; the ONLY write is a WAL restore-point record — it does NOT mutate
// any tenant table):
//   1. SELECT pg_create_restore_point('<label>') — stamps a NAMED PITR target into the WAL and
//      returns its LSN (the exact pre-flip position).
//   2. captures server now() (the --type=time PITR fallback target) + the current timeline.
//   3. if --pgbackrest-exec is given (and not --no-backup): triggers an INCREMENTAL pgBackRest
//      backup of the stanza so the WAL up to the restore point is archived + a fresh anchor base
//      exists; records the resulting backup label from `pgbackrest info`.
//   4. writes a snapshot record { label, lsn, restorePointTime, stanza, timeline, capturedAt,
//      backupLabel? } into the cutover --state under the top-level `snapshot` key (merging, not
//      clobbering, any existing soak watermarks in the same file).
//
// This is the EVIDENCE the orchestrator records before the flip; on rollback it emits the precise
// PITR restore command for this exact point. NOTHING here runs a restore (restore is destructive +
// operator-gated). The live cluster is only WAL-restore-point-stamped, never restored.
//
// `--stamp` is a CLI arg (Date.now() may be restricted under tsx) used as capturedAt.

import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import pg from "pg";
import { buildCreateRestorePointSql, buildSnapshotRecord, assertValidLabel } from "./lib/snapshot.ts";

function parseArgs(argv) {
  const out = { stanza: "cosmos", noBackup: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i];
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--stamp") out.stamp = argv[++i];
    else if (a === "--state") out.state = argv[++i];
    else if (a === "--stanza") out.stanza = argv[++i];
    else if (a === "--pgbackrest-exec") out.pgbackrestExec = argv[++i];
    else if (a === "--no-backup") out.noBackup = true;
    else fail(`unknown arg ${a}`);
  }
  return out;
}
function fail(msg, code = 2) {
  console.error(`snapshot-capture: ${msg}`);
  process.exit(code);
}
function req(args, name, flag) {
  if (!args[name]) fail(`missing required --${flag}`);
  return args[name];
}

/** Run a command (argv) capturing stdout; resolves {code, stdout, stderr} (never rejects). */
function run(cmd, cmdArgs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (e) => resolve({ code: 1, stdout, stderr: String(e?.message ?? e) }));
  });
}

/** Load the state file (a missing/empty file = {}). Preserves whatever else is in it. */
async function loadState(path) {
  try {
    const text = await readFile(path, "utf8");
    const trimmed = text.trim();
    return trimmed === "" ? {} : JSON.parse(trimmed);
  } catch (e) {
    if (e?.code === "ENOENT") return {};
    throw e;
  }
}

/** Persist the state atomically (temp + rename) so a crash can't corrupt it. */
async function saveState(path, state) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
}

/**
 * Trigger an incremental pgBackRest backup via the supplied exec prefix, then read back the
 * latest backup label from `pgbackrest info --output=json`. Returns the label or null.
 * The exec prefix is split on whitespace into argv (e.g.
 *   "sudo docker compose exec -T -u postgres cosmos-postgres"
 * → the pgbackrest command is appended). Fail-soft: a backup failure does NOT abort the capture
 * (the restore point + LSN/time alone is still a valid PITR target) — it's logged + recorded as
 * a null backupLabel with a warning.
 */
async function triggerIncrBackupAndLabel(execPrefix, stanza) {
  const prefix = execPrefix.trim().split(/\s+/);
  const [cmd, ...prefixArgs] = prefix;

  console.log(`snapshot-capture: triggering incr pgBackRest backup (stanza=${stanza}) via "${execPrefix}"`);
  const backup = await run(cmd, [...prefixArgs, "pgbackrest", `--stanza=${stanza}`, "--type=incr", "backup"]);
  if (backup.code !== 0) {
    console.error(
      `snapshot-capture: WARNING — incr backup exited ${backup.code}; recording the restore point ` +
        `WITHOUT a backup label (the named restore point + WAL chain is still a valid PITR target).\n` +
        `${backup.stderr || backup.stdout}`,
    );
    return null;
  }

  // Read the latest backup label from pgbackrest info JSON.
  const info = await run(cmd, [...prefixArgs, "pgbackrest", `--stanza=${stanza}`, "info", "--output=json"]);
  if (info.code !== 0) {
    console.error(`snapshot-capture: WARNING — pgbackrest info failed; backup ran but label not read.`);
    return null;
  }
  try {
    const parsed = JSON.parse(info.stdout);
    const stanzaInfo = Array.isArray(parsed) ? parsed.find((s) => s.name === stanza) : null;
    const backups = stanzaInfo?.backup ?? [];
    const last = backups[backups.length - 1];
    return last?.label ?? null;
  } catch {
    console.error(`snapshot-capture: WARNING — could not parse pgbackrest info JSON; label not recorded.`);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const db = req(args, "db", "db");
  const label = assertValidLabel(req(args, "label", "label"));
  const stamp = req(args, "stamp", "stamp");
  const state = req(args, "state", "state");
  const stanza = args.stanza;

  console.log("══════════════════════════════════════════════════════════════════════");
  console.log("  COSMOS v2 — PRE-FLIP RESTORE-POINT CAPTURE (§9.4)");
  console.log(`  label "${label}"  stanza "${stanza}"  @ ${stamp}`);
  console.log("  Captures a NAMED PITR target + LSN/time (+ optional incr backup). The ONLY");
  console.log("  write is a WAL restore-point record — NO tenant table is mutated, NO restore is run.");
  console.log("══════════════════════════════════════════════════════════════════════");

  // ── 1+2. create the restore point + capture LSN / now() / timeline ──
  const client = new pg.Client({ connectionString: db });
  await client.connect();
  let lsn = null;
  let restorePointTime;
  let timeline = null;
  try {
    const rp = await client.query(buildCreateRestorePointSql(label));
    lsn = rp.rows?.[0]?.lsn ?? null;
    console.log(`snapshot-capture: pg_create_restore_point('${label}') → LSN ${lsn ?? "(none)"}`);

    const nowRes = await client.query("SELECT now() AT TIME ZONE 'UTC' AS now_utc");
    // Format as an explicit-UTC ISO string (the --type=time PITR target).
    const nowUtc = nowRes.rows?.[0]?.now_utc;
    restorePointTime =
      nowUtc instanceof Date ? nowUtc.toISOString() : new Date(`${nowUtc}Z`).toISOString();
    console.log(`snapshot-capture: server now() (UTC) → ${restorePointTime}`);

    // Timeline from pg_control_checkpoint (best-effort; null if the role can't read it).
    try {
      const tlRes = await client.query("SELECT timeline_id FROM pg_control_checkpoint()");
      timeline = tlRes.rows?.[0]?.timeline_id ?? null;
      console.log(`snapshot-capture: timeline → ${timeline ?? "(unavailable)"}`);
    } catch {
      console.log("snapshot-capture: timeline unavailable (role lacks pg_control_checkpoint) — recording null.");
    }
  } finally {
    await client.end();
  }

  // ── 3. optional incr pgBackRest backup (records the WAL up to the restore point) ──
  let backupLabel = null;
  if (args.pgbackrestExec && !args.noBackup) {
    backupLabel = await triggerIncrBackupAndLabel(args.pgbackrestExec, stanza);
    console.log(`snapshot-capture: backup label → ${backupLabel ?? "(none recorded)"}`);
  } else {
    console.log(
      "snapshot-capture: SKIP incr backup (" +
        (args.noBackup ? "--no-backup set" : "no --pgbackrest-exec") +
        ") — the named restore point + LSN/time is the PITR target; the existing WAL chain " +
        "+ last base backup make it restorable.",
    );
  }

  // ── 4. assemble + persist the snapshot record into --state (merging) ──
  const record = buildSnapshotRecord({
    label,
    lsn,
    restorePointTime,
    stanza,
    timeline,
    capturedAt: stamp,
    backupLabel,
  });
  const st = await loadState(state);
  st.snapshot = record;
  await saveState(state, st);

  console.log("──────────────────────────────────────────────────────────────────────");
  console.log(`snapshot-capture: recorded into ${state} under .snapshot:`);
  console.log(JSON.stringify(record, null, 2));
  // Stable machine-readable line for acceptance to grep.
  console.log(`SNAPSHOT_CAPTURE ${JSON.stringify(record)}`);
  console.log("──────────────────────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error(`snapshot-capture: unexpected error — ${err?.stack ?? err}`);
  process.exit(1);
});
