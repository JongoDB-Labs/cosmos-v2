#!/bin/sh
# One-shot: generate a self-signed TLS cert for the in-boundary MinIO into the shared
# certs volume (so MinIO serves HTTPS — encryption in transit, 3.8.6/3.13.8). Runs
# BEFORE MinIO starts. Idempotent: skips if a cert already exists in the volume.
#
# The cert/key live ONLY in the cosmos-minio-certs volume (NEVER committed to git — a
# private key in the repo would trip the gitleaks gate and is a real-secret smell). For
# gov this whole sidecar is replaced by GovCloud S3 (a real CA-signed endpoint).
set -eu

CERT_DIR=/certs
if [ -f "$CERT_DIR/public.crt" ] && [ -f "$CERT_DIR/private.key" ]; then
  echo "gen-certs: cert already present in volume — skipping."
  exit 0
fi

echo "gen-certs: generating self-signed cert for CN=cosmos-minio ..."
openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
  -keyout "$CERT_DIR/private.key" \
  -out "$CERT_DIR/public.crt" \
  -subj "/CN=cosmos-minio" \
  -addext "subjectAltName=DNS:cosmos-minio,DNS:localhost,IP:127.0.0.1"
chmod 0644 "$CERT_DIR/public.crt"
chmod 0600 "$CERT_DIR/private.key"
echo "gen-certs: done."
ls -la "$CERT_DIR"
