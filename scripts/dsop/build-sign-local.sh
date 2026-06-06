#!/usr/bin/env bash
# build-sign-local.sh — OFFLINE proof of the release.yml signed-delivery flow.
#
# Proves, without a GitHub remote or GHCR, that the same chain CI runs produces
# REAL evidence:
#   1. build the runtime image tagged from package.json `version`
#   2. produce a real Syft SPDX SBOM (anchore/syft docker image)
#   3. generate a local cosign keypair (CI uses keyless OIDC; here we prove
#      sign+verify with a key)
#   4. push the image to a throwaway local registry so cosign can sign BY DIGEST
#      (cosign signatures are an OCI artifact stored next to the image — the
#      registry is the realistic target; a bare daemon image has no digest ref)
#   5. cosign sign by digest, then cosign verify (must succeed)
#
# Artifacts land in evidence/local/ (gitignored). Tools run via Docker so the
# host needs nothing but docker (sudo) + node.
#
# Spec §8 gates 6 (SBOM) + 7 (sign/provenance).
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_ROOT="$PWD"

DOCKER="sudo docker"
SYFT_IMAGE="anchore/syft:latest"
COSIGN_IMAGE="gcr.io/projectsigstore/cosign:v2.4.1"
REGISTRY_IMAGE="registry:2"

EVID="$REPO_ROOT/evidence/local"
KEYDIR="$REPO_ROOT/evidence/local/cosign-keys"
SBOM="$EVID/sbom.spdx.json"
mkdir -p "$EVID" "$KEYDIR"
# The cosign image runs as a non-root user (uid 65532) and must be able to
# write the throwaway keypair into the host-mounted keydir. World-writable is
# fine: it's a disposable proof key, gitignored (CI uses keyless OIDC).
chmod 0777 "$KEYDIR"

VERSION="$(node -p "require('./package.json').version")"
IMAGE_TAG="cosmos-v2:${VERSION}"
REG_PORT=5055
REG_NAME="cosmos-v2-dsop-registry"
REG_REPO="localhost:${REG_PORT}/cosmos-v2"

echo "==> cosmos-v2 v${VERSION} — local build/sign proof"

# --- 1. build runtime image -------------------------------------------------
echo "==> [1/5] docker build ${IMAGE_TAG} (+ :latest)"
$DOCKER build --build-arg "APP_VERSION=${VERSION}" \
  -t "${IMAGE_TAG}" -t "cosmos-v2:latest" "$REPO_ROOT"

# --- 2. real Syft SPDX SBOM -------------------------------------------------
echo "==> [2/5] Syft SPDX SBOM → ${SBOM}"
# Syft inspects the image via the host docker daemon (socket mounted in).
$DOCKER run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$SYFT_IMAGE" "${IMAGE_TAG}" -o spdx-json > "$SBOM"

PKG_COUNT="$(node -e "const s=require('${SBOM}');console.log((s.packages||[]).length)")"
echo "    SBOM package count: ${PKG_COUNT}"
if [ "${PKG_COUNT}" -lt 1 ]; then
  echo "ERROR: SBOM has no packages — Syft did not inspect the image." >&2
  exit 1
fi

# --- 3. local cosign keypair (CI uses keyless OIDC) -------------------------
echo "==> [3/5] cosign generate-key-pair (local; CI is keyless)"
rm -f "$KEYDIR/cosign.key" "$KEYDIR/cosign.pub"
# Empty password for the throwaway proof key.
$DOCKER run --rm -e COSIGN_PASSWORD="" \
  -v "$KEYDIR:/keys" -w /keys \
  "$COSIGN_IMAGE" generate-key-pair
ls -l "$KEYDIR/cosign.key" "$KEYDIR/cosign.pub"

# --- 4. push to throwaway local registry so we can sign BY DIGEST ----------
echo "==> [4/5] push ${IMAGE_TAG} → ${REG_REPO} (local registry)"
$DOCKER rm -f "$REG_NAME" >/dev/null 2>&1 || true
$DOCKER run -d --name "$REG_NAME" -p "${REG_PORT}:5000" "$REGISTRY_IMAGE" >/dev/null
# Wait for the registry to accept connections.
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${REG_PORT}/v2/" >/dev/null 2>&1; then break; fi
  sleep 1
done
$DOCKER tag "${IMAGE_TAG}" "${REG_REPO}:${VERSION}"
$DOCKER push "${REG_REPO}:${VERSION}"
DIGEST="$($DOCKER inspect --format='{{index .RepoDigests 0}}' "${REG_REPO}:${VERSION}" | sed 's/.*@//')"
echo "    image digest: ${DIGEST}"
REG_REF="${REG_REPO}@${DIGEST}"

# --- 5. sign by digest + verify --------------------------------------------
echo "==> [5/5] cosign sign (by digest) + verify"
# --network host so the in-container cosign reaches localhost:5055.
# --allow-insecure-registry: the throwaway registry is plain HTTP.
$DOCKER run --rm --network host \
  -e COSIGN_PASSWORD="" \
  -v "$KEYDIR:/keys" -w /keys \
  "$COSIGN_IMAGE" sign --yes --allow-insecure-registry \
  --key /keys/cosign.key "${REG_REF}"

echo "    --- cosign verify ---"
$DOCKER run --rm --network host \
  -v "$KEYDIR:/keys" -w /keys \
  "$COSIGN_IMAGE" verify --allow-insecure-registry \
  --key /keys/cosign.pub "${REG_REF}" 2>&1 | tee "$EVID/cosign-verify.txt"

VERIFY_RC=${PIPESTATUS[0]}

# cleanup the throwaway registry (the signature/SBOM evidence is on disk).
$DOCKER rm -f "$REG_NAME" >/dev/null 2>&1 || true

echo
if [ "${VERIFY_RC}" -eq 0 ]; then
  echo "==> PROOF OK — SBOM packages=${PKG_COUNT}; cosign verify SUCCEEDED for ${IMAGE_TAG}@${DIGEST}"
else
  echo "==> PROOF FAILED — cosign verify returned ${VERIFY_RC}" >&2
  exit 1
fi
