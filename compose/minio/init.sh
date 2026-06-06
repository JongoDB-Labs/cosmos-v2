#!/bin/sh
# One-shot MinIO bootstrap (runs in the minio/mc image after MinIO is healthy).
#
# Creates the three in-boundary buckets and the LEAST-PRIVILEGE service accounts
# the rest of the stack uses. Idempotent: re-running is safe (mc mb --ignore-existing,
# policy/user create tolerate "already exists").
#
#   cosmos-uploads      RW  — the S3 storage adapter (app uploads/evidence).
#   cosmos-pgbackrest   RW  — the pgBackRest backup repo (postgres writes + prunes WAL/backups).
#   cosmos-audit-worm   APPEND-ONLY (write + read for verification; NO delete / overwrite /
#                           retention-bypass), object-locked (COMPLIANCE retention)
#                           — the AU-9 offsite immutable audit anchor.
#
# Service accounts (NOT the root key — root stays inside MinIO only):
#   - the app/backrest key (S3_ACCESS_KEY): RW on cosmos-uploads + cosmos-pgbackrest only.
#   - the worm key (WORM_ACCESS_KEY): PutObject + GetObject + ListBucket on cosmos-audit-worm
#     ONLY. NO DeleteObject, NO version deletion, NO retention bypass. Read (GetObject) is
#     intentionally granted — a verifier diffing the live DB against the WORM copy needs it
#     (that IS the AU-9 use case). Combined with the bucket's COMPLIANCE object-lock this
#     makes the audit export append-only by both IAM policy AND object-lock (defense in
#     depth, AU-9). "Append-only" = write + read, NO delete / overwrite / retention-bypass.
set -eu

# --insecure: MinIO serves a self-signed internal cert (a known internal CA, not a
# public one). TLS is still on (encryption in transit); only hostname/CA verification
# is skipped for this in-boundary link. In gov this points at a CA-signed GovCloud S3.
MC="/usr/bin/mc --insecure"
ALIAS=local

echo "==> waiting for MinIO at ${MINIO_ENDPOINT} ..."
until ${MC} alias set ${ALIAS} "${MINIO_ENDPOINT}" "${MINIO_ROOT_USER}" "${MINIO_ROOT_PASSWORD}" >/dev/null 2>&1; do
  sleep 2
done
echo "==> MinIO reachable."

# ── Buckets ────────────────────────────────────────────────────────────────────
${MC} mb --ignore-existing ${ALIAS}/cosmos-uploads
${MC} mb --ignore-existing ${ALIAS}/cosmos-pgbackrest
# Object-lock MUST be enabled at creation time; --with-lock is a no-op (warning) if
# the bucket already exists with locking on, and errors if it exists WITHOUT it.
${MC} mb --with-lock --ignore-existing ${ALIAS}/cosmos-audit-worm

# ── Object-lock retention on the WORM bucket (COMPLIANCE mode) ────────────────────
# COMPLIANCE (vs GOVERNANCE): NO user, not even root, can shorten/remove the lock or
# delete a locked object until the retention period elapses. This is the immutability
# guarantee the audit anchor needs. Default retention applied to every new object.
${MC} retention set --default COMPLIANCE "${WORM_RETENTION_DAYS:-3650}d" ${ALIAS}/cosmos-audit-worm
echo "==> object-lock (COMPLIANCE, ${WORM_RETENTION_DAYS:-3650}d default) set on cosmos-audit-worm."

# ── Least-privilege policies ─────────────────────────────────────────────────────
cat >/tmp/policy-app.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:*"],
      "Resource": [
        "arn:aws:s3:::cosmos-uploads",
        "arn:aws:s3:::cosmos-uploads/*",
        "arn:aws:s3:::cosmos-pgbackrest",
        "arn:aws:s3:::cosmos-pgbackrest/*"
      ]
    }
  ]
}
JSON

# APPEND-ONLY (write + read for verification; NO delete / overwrite / retention-bypass).
# NO s3:DeleteObject, NO s3:DeleteObjectVersion, NO s3:BypassGovernanceRetention. Grants:
#   - PutObject:  write the dump + manifest (object-lock blocks overwrite of an existing key).
#   - GetObject:  a verifier diffs the live DB against the WORM copy — the AU-9 use case;
#                 read is legitimate and is NOT a tamper vector (delete/overwrite are).
#   - ListBucket: the export job derives each table's "last attested toSeq" by listing the
#                 per-table manifest objects, without granting any mutate/delete verb.
cat >/tmp/policy-worm.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:GetBucketObjectLockConfiguration"
      ],
      "Resource": [
        "arn:aws:s3:::cosmos-audit-worm",
        "arn:aws:s3:::cosmos-audit-worm/*"
      ]
    }
  ]
}
JSON

${MC} admin policy create ${ALIAS} cosmos-app-rw /tmp/policy-app.json   2>/dev/null || \
  ${MC} admin policy update ${ALIAS} cosmos-app-rw /tmp/policy-app.json || true
${MC} admin policy create ${ALIAS} cosmos-worm-wo /tmp/policy-worm.json 2>/dev/null || \
  ${MC} admin policy update ${ALIAS} cosmos-worm-wo /tmp/policy-worm.json || true

# ── Service accounts (the keys the stack actually uses) ──────────────────────────
${MC} admin user add ${ALIAS} "${S3_ACCESS_KEY}" "${S3_SECRET_KEY}" 2>/dev/null || true
${MC} admin policy attach ${ALIAS} cosmos-app-rw --user "${S3_ACCESS_KEY}" 2>/dev/null || true

${MC} admin user add ${ALIAS} "${WORM_ACCESS_KEY}" "${WORM_SECRET_KEY}" 2>/dev/null || true
${MC} admin policy attach ${ALIAS} cosmos-worm-wo --user "${WORM_ACCESS_KEY}" 2>/dev/null || true

echo "==> service accounts provisioned (app RW: uploads+pgbackrest; worm WO: audit-worm)."
echo "==> MinIO bootstrap complete:"
${MC} ls ${ALIAS}
echo "==> retention on cosmos-audit-worm:"
${MC} retention info --default ${ALIAS}/cosmos-audit-worm || true
