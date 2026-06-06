#!/usr/bin/env node
// audit-worm-export.mjs — AU-9 OFFSITE IMMUTABLE AUDIT ANCHOR.
//
// Dumps audit_logs + egress_decisions rows produced SINCE the last export (by the
// monotonic `seq` IDENTITY column) to NDJSON, computes a sha256 over the canonical
// dump, signs a manifest with an HMAC, and PUTs BOTH to the object-locked
// cosmos-audit-worm bucket. The bucket's COMPLIANCE object-lock + the export key's
// write-only/no-delete policy make the copy append-only by both object-lock AND IAM —
// so post-hoc tampering with the LIVE DB is detectable by diffing against this offsite
// copy (the external anchor the deferred in-DB hash-chain was waiting on).
//
// IDEMPOTENT on toSeq: the object keys embed toSeq, and object-lock REJECTS any
// overwrite, so a re-run for an already-exported window is a no-op (or a deliberate,
// proof-of-immutability rejection). When there are no new rows it exits 0 without
// writing.
//
// Env (see docker-compose `audit-worm-export` service + .env.example):
//   DATABASE_URL            read creds (SELECT on the audit tables is enough)
//   WORM_S3_ENDPOINT        MinIO endpoint (path-style)
//   WORM_S3_BUCKET          cosmos-audit-worm
//   WORM_S3_ACCESS_KEY/_SECRET_KEY   the WRITE-ONLY worm key
//   WORM_MANIFEST_HMAC_KEY  HMAC key for signing the manifest
//   WORM_S3_REGION          optional (default us-east-1)
//   WORM_FORCE_PATH_STYLE   optional (default true)

import { createHash, createHmac } from "node:crypto";
import pg from "pg";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

function reqEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`audit-worm-export: missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

const DATABASE_URL = reqEnv("DATABASE_URL");
const BUCKET = reqEnv("WORM_S3_BUCKET");
const ENDPOINT = reqEnv("WORM_S3_ENDPOINT");
const ACCESS_KEY = reqEnv("WORM_S3_ACCESS_KEY");
const SECRET_KEY = reqEnv("WORM_S3_SECRET_KEY");
const HMAC_KEY = reqEnv("WORM_MANIFEST_HMAC_KEY");
const REGION = process.env.WORM_S3_REGION ?? "us-east-1";
const FORCE_PATH_STYLE = (process.env.WORM_FORCE_PATH_STYLE ?? "true") !== "false";

const PREFIX = "audit-exports";

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  forcePathStyle: FORCE_PATH_STYLE,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

// JSON that round-trips BigInt (seq) as a string — both for the NDJSON dump and the
// manifest. Canonicalization matters for the sha256: we always serialize a row with
// its keys in the order returned, which pg keeps stable for a fixed query.
function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

// The high-water mark already in the WORM bucket: parse `...-toSeq-<N>.ndjson` from the
// existing dump object keys (ListBucket is granted to the worm key; no delete needed).
async function lastExportedToSeq() {
  let max = 0n;
  let ContinuationToken;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: `${PREFIX}/`,
        ContinuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      const m = /toSeq-(\d+)\.ndjson$/.exec(obj.Key ?? "");
      if (m) {
        const v = BigInt(m[1]);
        if (v > max) max = v;
      }
    }
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return max;
}

async function fetchRowsSince(client, table, fromSeq) {
  // Parameterized; seq is BIGINT — pg returns it as a string, which we BigInt() so the
  // ordering + max are exact. `seq IS NOT NULL` guards any legacy pre-IDENTITY rows.
  const { rows } = await client.query(
    `SELECT * FROM ${table} WHERE seq IS NOT NULL AND seq > $1 ORDER BY seq ASC`,
    [fromSeq.toString()],
  );
  return rows;
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  let fromSeq;
  try {
    fromSeq = await lastExportedToSeq();
  } catch (err) {
    console.error(
      `audit-worm-export: could not list existing exports (${err?.name ?? "error"}): ${err?.message}`,
    );
    await client.end();
    process.exit(1);
  }

  const auditRows = await fetchRowsSince(client, "audit_logs", fromSeq);
  const egressRows = await fetchRowsSince(client, "egress_decisions", fromSeq);
  await client.end();

  const rowCount = auditRows.length + egressRows.length;
  if (rowCount === 0) {
    console.log(
      `audit-worm-export: no new rows since seq ${fromSeq} — nothing to export (idempotent no-op).`,
    );
    return;
  }

  // toSeq = the max seq across BOTH tables (they share one logical timeline by seq).
  const maxSeq = (rows) =>
    rows.reduce((m, r) => (BigInt(r.seq) > m ? BigInt(r.seq) : m), 0n);
  const toSeq = (maxSeq(auditRows) > maxSeq(egressRows)
    ? maxSeq(auditRows)
    : maxSeq(egressRows));

  // Canonical NDJSON: one line per row, audit_logs first then egress_decisions, each
  // ordered by seq. Tagged with `_table` so a verifier can split them back.
  const lines = [];
  for (const r of auditRows) lines.push(JSON.stringify({ _table: "audit_logs", ...r }, jsonReplacer));
  for (const r of egressRows) lines.push(JSON.stringify({ _table: "egress_decisions", ...r }, jsonReplacer));
  const ndjson = lines.join("\n") + "\n";

  const sha256 = createHash("sha256").update(ndjson, "utf8").digest("hex");
  const exportedAt = new Date().toISOString();

  const manifestCore = {
    fromSeq: fromSeq.toString(),
    toSeq: toSeq.toString(),
    rowCount,
    auditRows: auditRows.length,
    egressRows: egressRows.length,
    sha256,
    exportedAt,
    algo: "sha256",
    // Pin the dump object this manifest attests to.
    dumpKey: `${PREFIX}/dump-toSeq-${toSeq}.ndjson`,
  };
  // Sign the canonicalized manifest core so manifest tampering is also detectable.
  const signature = createHmac("sha256", HMAC_KEY)
    .update(JSON.stringify(manifestCore))
    .digest("hex");
  const manifest = { ...manifestCore, signatureAlgo: "hmac-sha256", signature };

  const dumpKey = `${PREFIX}/dump-toSeq-${toSeq}.ndjson`;
  const manifestKey = `${PREFIX}/manifest-toSeq-${toSeq}.json`;

  // PUT the dump then the manifest. Object-lock COMPLIANCE retention is applied to every
  // new object by the bucket default — no per-PUT retention header needed (and the
  // write-only key can't set/bypass retention anyway). A re-PUT of an existing toSeq key
  // is REJECTED by object-lock (the immutability proof).
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: dumpKey,
        Body: Buffer.from(ndjson, "utf8"),
        ContentType: "application/x-ndjson",
      }),
    );
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: manifestKey,
        Body: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
        ContentType: "application/json",
      }),
    );
  } catch (err) {
    const name = err?.name ?? "error";
    // An overwrite of an already-locked object surfaces here. Make it loud + actionable.
    console.error(
      `audit-worm-export: PUT to ${BUCKET} failed (${name}): ${err?.message}`,
    );
    console.error(
      "  If this is 'object is WORM protected' / retention, the window was already exported (object-lock is working as intended).",
    );
    process.exit(1);
  }

  console.log(
    `audit-worm-export: exported ${rowCount} rows (audit=${auditRows.length}, egress=${egressRows.length}) ` +
      `seq ${fromSeq} → ${toSeq}\n` +
      `  dump:     s3://${BUCKET}/${dumpKey}\n` +
      `  manifest: s3://${BUCKET}/${manifestKey}\n` +
      `  sha256:   ${sha256}`,
  );
}

main().catch((err) => {
  console.error(`audit-worm-export: unexpected error: ${err?.stack ?? err}`);
  process.exit(1);
});
