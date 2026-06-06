#!/usr/bin/env node
// audit-worm-export.mjs — AU-9 OFFSITE IMMUTABLE AUDIT ANCHOR.
//
// Dumps audit_logs + egress_decisions rows produced SINCE the last export (by each
// table's monotonic `seq` IDENTITY column) to NDJSON, computes a sha256 over the
// canonical dump, signs a manifest with an HMAC, and PUTs BOTH to the object-locked
// cosmos-audit-worm bucket. The bucket's COMPLIANCE object-lock + the export key's
// append-only (write + read for verification; NO delete / overwrite / retention-bypass)
// policy make the copy immutable by both object-lock AND IAM — so post-hoc tampering
// with the LIVE DB is detectable by diffing against this offsite copy (the external
// anchor the deferred in-DB hash-chain was waiting on).
//
// TWO INDEPENDENT IDENTITY DOMAINS (do NOT conflate them):
//   audit_logs.seq and egress_decisions.seq are SEPARATE `GENERATED ALWAYS AS IDENTITY`
//   sequences, each counting from 1, advancing at very different rates. A single shared
//   watermark across both would let the lower-seq table silently skip rows in the gap
//   between its real last seq and the other table's higher seq. So each table is its
//   OWN export stream under its OWN object-key prefix with its OWN watermark:
//     audit-exports/audit_logs/{dump,manifest}-toSeq-<N>.{ndjson,json}
//     audit-exports/egress_decisions/{dump,manifest}-toSeq-<M>.{ndjson,json}
//   Each table derives fromSeq from ITS prefix, queries `seq > fromSeq ORDER BY seq ASC`,
//   computes its own toSeq, and writes its own dump + manifest. The two domains never
//   share a watermark — every committed row in either table lands in some dump.
//
// WATERMARK IS MANIFEST-DERIVED + SELF-HEALING (closes the un-attested-window gap):
//   A `toSeq` only "counts as exported" once its SIGNED MANIFEST exists — the high-water
//   mark is parsed from MANIFEST keys, not dump keys. The dump is PUT before the manifest;
//   if the run dies between them, the window has a dump but no manifest, so the next run
//   re-attempts that same window: it recomputes the (deterministic) dump bytes, PUTs the
//   dump with IfNoneMatch:"*" and TOLERATES a 412/PreconditionFailed (the prior partial
//   already wrote identical immutable bytes — committed audit rows never change, so
//   `seq>from ORDER BY seq` is byte-deterministic), then PUTs the manifest. The window
//   only succeeds once BOTH objects exist; a fully-exported window (manifest already past
//   it) is a clean no-op. Idempotent and gap-free under partial-failure / kill / retry.
//
// MinIO version note: IfNoneMatch:"*" conditional-write requires MinIO >= RELEASE.2024-09
// (older builds reject the `*` wildcard). Object-lock (COMPLIANCE retention) is the PRIMARY
// immutability guarantee; IfNoneMatch is defense-in-depth at the key level (and the
// mechanism that makes a dump-only partial self-heal without surfacing a false tamper).
//
// Env (see docker-compose `audit-worm-export` service + .env.example):
//   DATABASE_URL            read creds — uses the least-privilege cosmos_app role (SELECT
//                           on the audit tables is enough; NOT the owner)
//   WORM_S3_ENDPOINT        MinIO endpoint (path-style)
//   WORM_S3_BUCKET          cosmos-audit-worm
//   WORM_S3_ACCESS_KEY/_SECRET_KEY   the append-only worm key (write + read, no delete)
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

// The two INDEPENDENT IDENTITY domains. Each exports under its own prefix with its own
// watermark; they MUST NOT share a high-water mark (see header).
const TABLES = ["audit_logs", "egress_decisions"];

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  forcePathStyle: FORCE_PATH_STYLE,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
});

// JSON that round-trips BigInt (seq) as a string — both for the NDJSON dump and the
// manifest. Canonicalization matters for the sha256: we always serialize a row with
// its keys in the order returned, which pg keeps stable for a fixed query — so the
// dump bytes for a given window are deterministic across runs (required for the
// self-heal: a re-PUT of a partially-written window produces identical bytes).
function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function dumpKeyFor(table, toSeq) {
  return `${PREFIX}/${table}/dump-toSeq-${toSeq}.ndjson`;
}
function manifestKeyFor(table, toSeq) {
  return `${PREFIX}/${table}/manifest-toSeq-${toSeq}.json`;
}

// A 412 from a conditional PUT means the immutable object for this exact window already
// exists (a prior partial/complete run wrote identical bytes). Treat it as success.
function isPreconditionFailed(err) {
  const name = err?.name ?? "";
  const code = err?.Code ?? err?.code ?? "";
  const status = err?.$metadata?.httpStatusCode;
  return (
    name === "PreconditionFailed" ||
    code === "PreconditionFailed" ||
    status === 412
  );
}

// Per-table high-water mark already ATTESTED in the WORM bucket: parse
// `.../<table>/manifest-toSeq-<N>.json` — the MANIFEST (signed proof), NOT the dump.
// A window only counts as exported once its signed manifest exists, so a dump-only
// partial does NOT advance the watermark and is re-attempted on the next run.
async function lastAttestedToSeq(table) {
  let max = 0n;
  let ContinuationToken;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: `${PREFIX}/${table}/`,
        ContinuationToken,
      }),
    );
    for (const obj of res.Contents ?? []) {
      const m = /manifest-toSeq-(\d+)\.json$/.exec(obj.Key ?? "");
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

// Export one INDEPENDENT table stream. Returns a summary object, or null for a no-op.
async function exportTable(client, table) {
  const fromSeq = await lastAttestedToSeq(table);
  const rows = await fetchRowsSince(client, table, fromSeq);

  if (rows.length === 0) {
    console.log(
      `audit-worm-export[${table}]: no new rows since attested seq ${fromSeq} — nothing to export (idempotent no-op).`,
    );
    return null;
  }

  const maxSeq = rows.reduce(
    (m, r) => (BigInt(r.seq) > m ? BigInt(r.seq) : m),
    0n,
  );
  const toSeq = maxSeq;

  // Canonical NDJSON: one line per row, ordered by seq. Tagged with `_table` so a
  // verifier can confirm the domain. Deterministic for a given (table, from, to) window.
  const ndjson =
    rows.map((r) => JSON.stringify({ _table: table, ...r }, jsonReplacer)).join("\n") +
    "\n";

  const sha256 = createHash("sha256").update(ndjson, "utf8").digest("hex");
  const exportedAt = new Date().toISOString();

  const dumpKey = dumpKeyFor(table, toSeq);
  const manifestKey = manifestKeyFor(table, toSeq);

  const manifestCore = {
    table,
    fromSeq: fromSeq.toString(),
    toSeq: toSeq.toString(),
    rowCount: rows.length,
    sha256,
    exportedAt,
    algo: "sha256",
    // Pin the dump object this manifest attests to.
    dumpKey,
  };
  // Sign the canonicalized manifest core so manifest tampering is also detectable.
  const signature = createHmac("sha256", HMAC_KEY)
    .update(JSON.stringify(manifestCore))
    .digest("hex");
  const manifest = { ...manifestCore, signatureAlgo: "hmac-sha256", signature };

  // Compute both payloads in memory FIRST, then PUT dump→manifest. Two layers of
  // immutability + a self-heal for a partial prior run:
  //   1. IfNoneMatch:"*" — conditional write that 412s if the key already exists. The
  //      window is byte-deterministic, so a 412 means a prior run already wrote the
  //      identical immutable bytes for this window. We TOLERATE it (not a tamper): the
  //      dump may be from a partial run that died before the manifest — we then write
  //      the manifest and the watermark advances. Self-healing.
  //   2. Bucket-default COMPLIANCE object-lock — the written version can't be DELETED or
  //      its retention shortened until expiry (not even by root). The worm key also
  //      lacks any delete/retention-bypass verb.
  // The window only "succeeds" (advances the manifest-derived watermark) once BOTH the
  // dump AND the signed manifest exist. IfNoneMatch:"*" needs MinIO >= RELEASE.2024-09.
  await putImmutable(dumpKey, Buffer.from(ndjson, "utf8"), "application/x-ndjson");
  await putImmutable(
    manifestKey,
    Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    "application/json",
  );

  return { table, fromSeq, toSeq, rowCount: rows.length, sha256, dumpKey, manifestKey };
}

// PUT an object once, append-only. Tolerates 412 (object already exists with the same
// immutable bytes — a benign re-run or a self-heal of a partial prior run). Any other
// error is fatal and loud.
async function putImmutable(Key, Body, ContentType) {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key,
        Body,
        ContentType,
        IfNoneMatch: "*",
      }),
    );
  } catch (err) {
    if (isPreconditionFailed(err)) {
      // Already present (object-lock-immutable, identical bytes). Idempotent — fine.
      console.log(
        `audit-worm-export: ${Key} already present (412) — idempotent, continuing.`,
      );
      return;
    }
    const name = err?.name ?? "error";
    console.error(
      `audit-worm-export: PUT s3://${BUCKET}/${Key} failed (${name}): ${err?.message}`,
    );
    process.exit(1);
  }
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  const summaries = [];
  try {
    for (const table of TABLES) {
      const summary = await exportTable(client, table);
      if (summary) summaries.push(summary);
    }
  } catch (err) {
    await client.end();
    console.error(
      `audit-worm-export: export failed (${err?.name ?? "error"}): ${err?.message}`,
    );
    process.exit(1);
  }
  await client.end();

  if (summaries.length === 0) {
    console.log("audit-worm-export: all tables up to date — nothing exported.");
    return;
  }

  for (const s of summaries) {
    console.log(
      `audit-worm-export[${s.table}]: exported ${s.rowCount} rows seq ${s.fromSeq} → ${s.toSeq}\n` +
        `  dump:     s3://${BUCKET}/${s.dumpKey}\n` +
        `  manifest: s3://${BUCKET}/${s.manifestKey}\n` +
        `  sha256:   ${s.sha256}`,
    );
  }
}

main().catch((err) => {
  console.error(`audit-worm-export: unexpected error: ${err?.stack ?? err}`);
  process.exit(1);
});
