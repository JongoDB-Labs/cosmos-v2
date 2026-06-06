#!/bin/bash
# Render /etc/pgbackrest/pgbackrest.conf from the template, substituting secrets from
# env (so nothing sensitive is baked into the image). Run by the entrypoint wrapper on
# the postgres container AND by cosmos-backup.sh on the backup one-shot. Idempotent.
set -euo pipefail

TEMPLATE=/etc/pgbackrest/pgbackrest.conf.template
OUT=/etc/pgbackrest/pgbackrest.conf

: "${PGBACKREST_REPO1_S3_KEY:?PGBACKREST_REPO1_S3_KEY required}"
: "${PGBACKREST_REPO1_S3_KEY_SECRET:?PGBACKREST_REPO1_S3_KEY_SECRET required}"
: "${PGBACKREST_REPO1_CIPHER_PASS:?PGBACKREST_REPO1_CIPHER_PASS required}"
: "${PGBACKREST_REPO1_S3_ENDPOINT:?PGBACKREST_REPO1_S3_ENDPOINT required}"

# Use a sed that won't choke on / or & in secrets: pipe-delimited with escaping of |.
esc() { printf '%s' "$1" | sed -e 's/[|]/\\|/g'; }

sed \
  -e "s|__REPO1_S3_ENDPOINT__|$(esc "$PGBACKREST_REPO1_S3_ENDPOINT")|g" \
  -e "s|__REPO1_S3_KEY__|$(esc "$PGBACKREST_REPO1_S3_KEY")|g" \
  -e "s|__REPO1_S3_KEY_SECRET__|$(esc "$PGBACKREST_REPO1_S3_KEY_SECRET")|g" \
  -e "s|__REPO1_CIPHER_PASS__|$(esc "$PGBACKREST_REPO1_CIPHER_PASS")|g" \
  "$TEMPLATE" >"$OUT"

chmod 0640 "$OUT"
chown postgres:postgres "$OUT" 2>/dev/null || true
echo "render-pgbackrest-conf: wrote $OUT (endpoint=$PGBACKREST_REPO1_S3_ENDPOINT, repo encrypted)"
