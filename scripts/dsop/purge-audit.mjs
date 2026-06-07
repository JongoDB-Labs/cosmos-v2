#!/usr/bin/env node
// purge-audit.mjs — AU-11 sanctioned audit RETENTION-PURGE with signed chain-checkpoint.
//
// The ONE legitimate path that deletes audit rows. Deletes rows OLDER than the retention
// floor from audit_logs / egress_decisions WITHOUT breaking the AU-9 in-DB hash-chain, by
// recording a signed chain-checkpoint at the purge boundary FIRST (see migration
// 20260606130000_audit_retention_checkpoint + docs/runbooks/audit-integrity.md).
//
// ── How it stays tamper-evident across the purge boundary ──
//   1. Connects as the OWNER (cosmos) — NOT cosmos_app (which is REVOKEd DELETE and cannot
//      even SET session_replication_role). cosmos_app can NEVER reach this path.
//   2. Computes N = max(seq) among rows with created_at < now() - retentionDays.
//   3. WORM-ORDERING GUARD: refuses unless N <= the latest WORM-attested toSeq for the table
//      (so we NEVER delete a row that wasn't anchored offsite first). The WORM high-water
//      mark is read from the cosmos-audit-worm bucket's signed manifest keys (same source the
//      exporter advances), OR provided via --worm-toseq for air-gapped/owner runs.
//   4. GOV FLOOR GUARD: refuses retentionDays < 1095 (the 3-year gov floor) UNLESS the
//      explicit, obvious, TEST-ONLY override env AUDIT_PURGE_ALLOW_BELOW_FLOOR_DAYS=<n> is set
//      AND retentionDays >= that value. This override is for the Docker acceptance / tests
//      only; it is loud and never silently bypasses the floor.
//   5. In ONE transaction, as owner, SET LOCAL session_replication_role = replica (the only
//      way to bypass the 20260606050000 append-only trigger — for this txn only): INSERT the
//      signed checkpoint (table, N, row_hash@N, HMAC), then DELETE FROM <table> WHERE seq<=N.
//      The first RETAINED row's prev_hash still equals the checkpoint's row_hash (the link
//      survives the delete), so verify_audit_chain re-anchors at the checkpoint.
//   6. Idempotent / safe to re-run: if a checkpoint at >= N already exists OR there is nothing
//      below the cutoff, it is a clean no-op.
//
// The checkpoint sig is HMAC_sha256(key, tableName + String(N) + hex(rowHash@N)) — the EXACT
// canonical input scripts/dsop/verify-audit-chain.mjs recomputes to detect a forged checkpoint
// (a SQL function can't read the key from env; the SQL function anchors STRUCTURALLY, the JS
// wrapper checks the sig). Defaults to the WORM_MANIFEST_HMAC_KEY env (override with
// --hmac-key-env <NAME>).
//
// Usage (owner DATABASE_URL):
//   node scripts/dsop/purge-audit.mjs --table audit_logs --retention-days 1095
//   node scripts/dsop/purge-audit.mjs --table egress_decisions --retention-days 1095 \
//        --hmac-key-env AUDIT_CHECKPOINT_HMAC_KEY --worm-toseq 12345
//   # TEST-ONLY small-N (Docker acceptance): floor override is explicit + loud.
//   AUDIT_PURGE_ALLOW_BELOW_FLOOR_DAYS=0 node scripts/dsop/purge-audit.mjs \
//        --table audit_logs --retention-days 0 --worm-toseq <N>
//
// Env:
//   DATABASE_URL                       OWNER (cosmos) creds — REQUIRED (must NOT be cosmos_app).
//   <hmac key env>                     the checkpoint HMAC key (default WORM_MANIFEST_HMAC_KEY).
//   AUDIT_PURGE_ALLOW_BELOW_FLOOR_DAYS TEST-ONLY floor override (see guard 4). Omit in prod.
//   WORM_S3_* / WORM_MANIFEST_HMAC_KEY when reading the WORM high-water mark from S3 (guard 3),
//                                      unless --worm-toseq is given.
// Exit: 0 = purged or clean no-op; 1 = a guard refused / config / SQL error.

import { createHmac } from "node:crypto";
import pg from "pg";

const TABLES = new Set(["audit_logs", "egress_decisions"]);
const GOV_FLOOR_DAYS = 1095; // NIST 800-171 3.3.1 / AU-11 3-year retention floor.

function fail(msg) {
  console.error(`purge-audit: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    table: null,
    retentionDays: null,
    hmacKeyEnv: "WORM_MANIFEST_HMAC_KEY",
    wormToSeq: null, // explicit override; else read from S3
    noWormCheck: false, // TEST-ONLY, requires the floor override too
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--table": args.table = next(); break;
      case "--retention-days": args.retentionDays = Number(next()); break;
      case "--hmac-key-env": args.hmacKeyEnv = next(); break;
      case "--worm-toseq": args.wormToSeq = BigInt(next()); break;
      case "--no-worm-check": args.noWormCheck = true; break;
      default: fail(`unknown arg ${a}`);
    }
  }
  return args;
}

// Canonical checkpoint sig — MUST match verify-audit-chain.mjs and the migration's proof.
//   HMAC_sha256(key, tableName + String(checkpointSeq) + hex(checkpointRowHash))
// rowHashHex is the lowercase hex of the BYTEA row_hash. Returns a Buffer (stored as BYTEA).
export function signCheckpoint(key, tableName, checkpointSeq, rowHashHex) {
  return createHmac("sha256", key)
    .update(`${tableName}${String(checkpointSeq)}${rowHashHex}`)
    .digest();
}

// Read the latest WORM-attested toSeq for a table from the object-locked bucket's MANIFEST
// keys (the signed proof — same high-water source the exporter advances). Lazily imports the
// S3 client so the script runs without aws-sdk when --worm-toseq is supplied. Returns BigInt
// (0n if the table has never been exported).
async function latestWormToSeq(table) {
  const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const reqEnv = (n) => {
    const v = process.env[n];
    if (!v) fail(`WORM check needs env ${n} (or pass --worm-toseq)`);
    return v;
  };
  const endpoint = reqEnv("WORM_S3_ENDPOINT");
  const bucket = reqEnv("WORM_S3_BUCKET");
  const accessKeyId = reqEnv("WORM_S3_ACCESS_KEY");
  const secretAccessKey = reqEnv("WORM_S3_SECRET_KEY");
  const region = process.env.WORM_S3_REGION ?? "us-east-1";
  const forcePathStyle = (process.env.WORM_FORCE_PATH_STYLE ?? "true") !== "false";
  const s3 = new S3Client({ endpoint, region, forcePathStyle, credentials: { accessKeyId, secretAccessKey } });

  let max = 0n;
  let ContinuationToken;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `audit-exports/${table}/`, ContinuationToken }),
    );
    for (const obj of res.Contents ?? []) {
      const m = /manifest-toSeq-(\d+)\.json$/.exec(obj.Key ?? "");
      if (m) { const v = BigInt(m[1]); if (v > max) max = v; }
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return max;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.table || !TABLES.has(args.table)) {
    fail(`--table must be one of: ${[...TABLES].join(", ")}`);
  }
  if (!Number.isInteger(args.retentionDays) || args.retentionDays < 0) {
    fail("--retention-days must be a non-negative integer");
  }

  // ── Guard 4: gov retention floor (>= 1095d) unless the explicit TEST override is set. ──
  const overrideRaw = process.env.AUDIT_PURGE_ALLOW_BELOW_FLOOR_DAYS;
  if (args.retentionDays < GOV_FLOOR_DAYS) {
    if (overrideRaw === undefined) {
      fail(
        `REFUSING: --retention-days ${args.retentionDays} is below the ${GOV_FLOOR_DAYS}-day gov ` +
          `retention floor (AU-11 / 3.3.1). To purge below the floor in a TEST environment only, ` +
          `set AUDIT_PURGE_ALLOW_BELOW_FLOOR_DAYS=<min-days> (this is loud and test-only).`,
      );
    }
    const overrideFloor = Number(overrideRaw);
    if (!Number.isInteger(overrideFloor) || overrideFloor < 0) {
      fail(`AUDIT_PURGE_ALLOW_BELOW_FLOOR_DAYS must be a non-negative integer (got "${overrideRaw}")`);
    }
    if (args.retentionDays < overrideFloor) {
      fail(
        `REFUSING: --retention-days ${args.retentionDays} is below the TEST override floor ${overrideFloor}.`,
      );
    }
    console.error(
      `purge-audit: ⚠️  TEST-ONLY FLOOR OVERRIDE ACTIVE — purging below the ${GOV_FLOOR_DAYS}-day gov floor ` +
        `(retention-days=${args.retentionDays}, override floor=${overrideFloor}). NEVER use this in production.`,
    );
  }

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) fail("missing required env DATABASE_URL (must be the OWNER role)");
  const hmacKey = process.env[args.hmacKeyEnv];
  if (!hmacKey) fail(`missing required HMAC key env ${args.hmacKeyEnv}`);

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    // Owner sanity: the script MUST run as a role that can SET session_replication_role
    // (superuser/owner). cosmos_app cannot — fail fast with a clear message if misconfigured.
    const { rows: who } = await client.query("SELECT current_user, session_user");
    const role = who[0].current_user;
    if (role === "cosmos_app") {
      fail("DATABASE_URL points at cosmos_app — purge MUST run as the OWNER (cosmos). Refusing.");
    }

    // Compute N = max(seq) among rows OLDER than the cutoff. Parameterized; table is from the
    // allow-list (not user input). created_at is the retention clock.
    const cutoffSql = `now() - ($1::int * interval '1 day')`;
    const { rows: nRows } = await client.query(
      `SELECT max(seq) AS n, count(*) AS cnt FROM "${args.table}"
         WHERE row_hash IS NOT NULL AND created_at < ${cutoffSql}`,
      [args.retentionDays],
    );
    const n = nRows[0].n === null ? null : BigInt(nRows[0].n);
    const candidateCount = Number(nRows[0].cnt);

    if (n === null || candidateCount === 0) {
      console.log(
        `purge-audit[${args.table}]: nothing older than ${args.retentionDays}d — clean no-op.`,
      );
      return;
    }

    // ── Idempotency: if a checkpoint already covers >= N, this window was already purged. ──
    const { rows: cpRows } = await client.query(
      `SELECT max(checkpoint_seq) AS maxcp FROM "audit_chain_checkpoint" WHERE table_name = $1`,
      [args.table],
    );
    const maxCp = cpRows[0].maxcp === null ? null : BigInt(cpRows[0].maxcp);
    if (maxCp !== null && maxCp >= n) {
      console.log(
        `purge-audit[${args.table}]: latest checkpoint seq ${maxCp} already covers N=${n} — clean no-op (idempotent).`,
      );
      return;
    }

    // ── Guard 3: WORM-ordering — never delete a row not yet anchored offsite. ──
    if (!args.noWormCheck) {
      const wormToSeq = args.wormToSeq ?? (await latestWormToSeq(args.table));
      if (n > wormToSeq) {
        fail(
          `REFUSING: N=${n} > latest WORM-attested toSeq=${wormToSeq} for ${args.table}. ` +
            `Run audit-worm-export FIRST so the rows being purged are anchored offsite. ` +
            `(WORM-export-first ordering — see docs/runbooks/audit-integrity.md.)`,
        );
      }
      console.error(
        `purge-audit[${args.table}]: WORM guard OK — N=${n} <= latest WORM toSeq=${wormToSeq}.`,
      );
    } else {
      // --no-worm-check is TEST-ONLY and ALSO requires the floor override (defense in depth:
      // you can't disable BOTH guards without explicitly being in a test env).
      if (overrideRaw === undefined) {
        fail("--no-worm-check is TEST-ONLY and requires AUDIT_PURGE_ALLOW_BELOW_FLOOR_DAYS to be set.");
      }
      console.error(`purge-audit[${args.table}]: ⚠️  WORM check DISABLED (--no-worm-check, test-only).`);
    }

    // Fetch the row_hash at seq N (the checkpoint hash) BEFORE deleting it.
    const { rows: hRows } = await client.query(
      `SELECT encode(row_hash, 'hex') AS hex FROM "${args.table}" WHERE seq = $1`,
      [n.toString()],
    );
    if (hRows.length === 0 || !hRows[0].hex) {
      fail(`could not read row_hash at seq ${n} for ${args.table}`);
    }
    const rowHashHex = hRows[0].hex;
    const sig = signCheckpoint(hmacKey, args.table, n, rowHashHex);

    // ── The purge: ONE owner txn, replica-mode bypasses the append-only trigger. ──
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      `INSERT INTO "audit_chain_checkpoint" (table_name, checkpoint_seq, checkpoint_row_hash, sig)
         VALUES ($1, $2, decode($3, 'hex'), $4)`,
      [args.table, n.toString(), rowHashHex, sig],
    );
    const del = await client.query(
      `DELETE FROM "${args.table}" WHERE seq <= $1`,
      [n.toString()],
    );
    await client.query("COMMIT");

    console.log(
      `purge-audit[${args.table}]: purged ${del.rowCount} rows (seq <= ${n}); ` +
        `signed checkpoint recorded at seq=${n}, row_hash=${rowHashHex.slice(0, 16)}…. ` +
        `Run verify-audit-chain to confirm the chain re-anchors at the checkpoint.`,
    );
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    await client.end();
    fail(`failed (${err?.name ?? "error"}): ${err?.message}`);
  }
  await client.end();
}

// Run only when invoked directly (allows importing signCheckpoint in tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`purge-audit: unexpected error: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
