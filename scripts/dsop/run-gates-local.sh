#!/usr/bin/env bash
# run-gates-local.sh — OFFLINE proof that the security.yml gate tools produce
# REAL evidence. Runs each OSS scanner via its Docker image against the repo +
# the cosmos-v2:<version> image, writing reports to evidence/local/.
#
# Tools: Trivy fs, Trivy image, gitleaks, hadolint, OSV-Scanner (spec §8 gates
# 2/3/4/5). This proof is record-only — it does NOT fail on pre-existing
# High/Medium findings (CI fails-on-Critical via security.yml); it summarizes
# counts and flags any Critical.
set -uo pipefail

cd "$(dirname "$0")/../.."
REPO_ROOT="$PWD"
DOCKER="sudo docker"
EVID="$REPO_ROOT/evidence/local"
mkdir -p "$EVID"

VERSION="$(node -p "require('./package.json').version")"
IMAGE_TAG="cosmos-v2:${VERSION}"

TRIVY_IMAGE="aquasec/trivy:latest"
GITLEAKS_IMAGE="zricethezav/gitleaks:latest"
HADOLINT_IMAGE="hadolint/hadolint:latest"
OSV_IMAGE="ghcr.io/google/osv-scanner:latest"

echo "==> cosmos-v2 v${VERSION} — local security-gate proof"

# --- Trivy filesystem scan (SCA, gate 2) -----------------------------------
echo "==> [1/5] Trivy fs (vuln + secret)"
$DOCKER run --rm -v "$REPO_ROOT:/r" -w /r "$TRIVY_IMAGE" \
  fs --scanners vuln,secret --format json -o /r/evidence/local/trivy-fs.json /r \
  >/dev/null 2>&1 || echo "    (trivy fs exited non-zero — report still written)"

# --- Trivy image scan (gate 4) ---------------------------------------------
echo "==> [2/5] Trivy image (${IMAGE_TAG})"
if $DOCKER image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  $DOCKER run --rm -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$REPO_ROOT:/r" "$TRIVY_IMAGE" \
    image --format json -o /r/evidence/local/trivy-image.json "$IMAGE_TAG" \
    >/dev/null 2>&1 || echo "    (trivy image exited non-zero — report still written)"
else
  echo "    SKIP: ${IMAGE_TAG} not present — run build-sign-local.sh first."
fi

# --- gitleaks (secrets, gate 3) --------------------------------------------
echo "==> [3/5] gitleaks (full history)"
$DOCKER run --rm -v "$REPO_ROOT:/r" "$GITLEAKS_IMAGE" \
  detect --source /r --report-format json \
  --report-path /r/evidence/local/gitleaks.json \
  >/dev/null 2>&1 || echo "    (gitleaks exited non-zero — finding(s) present, see report)"

# --- hadolint (IaC, gate 5) ------------------------------------------------
echo "==> [4/5] hadolint (Dockerfile)"
$DOCKER run --rm -i "$HADOLINT_IMAGE" hadolint --format json - < Dockerfile \
  > "$EVID/hadolint.json" 2>/dev/null || true
$DOCKER run --rm -i "$HADOLINT_IMAGE" hadolint - < Dockerfile \
  > "$EVID/hadolint.txt" 2>&1 || true

# --- OSV-Scanner (SCA, gate 2) ---------------------------------------------
echo "==> [5/5] OSV-Scanner (lockfile)"
$DOCKER run --rm -v "$REPO_ROOT:/r" "$OSV_IMAGE" \
  scan --lockfile=/r/package-lock.json --format json \
  > "$EVID/osv.json" 2>/dev/null || echo "    (osv-scanner exited non-zero — vulns present, see report)"

# --- summarize --------------------------------------------------------------
echo
echo "==================== FINDING COUNTS (record-only) ===================="
node - "$EVID" <<'NODE'
const fs = require("fs");
const path = require("path");
const dir = process.argv[2];
const read = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
  catch { return null; }
};

// Trivy severity tally across Results[].Vulnerabilities[]/Secrets[]
function trivyTally(j) {
  const t = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0, secrets: 0 };
  if (!j || !Array.isArray(j.Results)) return t;
  for (const r of j.Results) {
    for (const v of r.Vulnerabilities || []) t[v.Severity || "UNKNOWN"]++;
    t.secrets += (r.Secrets || []).length;
  }
  return t;
}

const tfs = trivyTally(read("trivy-fs.json"));
console.log(`Trivy fs      : CRIT=${tfs.CRITICAL} HIGH=${tfs.HIGH} MED=${tfs.MEDIUM} LOW=${tfs.LOW} secrets=${tfs.secrets}`);

const timg = read("trivy-image.json");
if (timg) {
  const t = trivyTally(timg);
  console.log(`Trivy image   : CRIT=${t.CRITICAL} HIGH=${t.HIGH} MED=${t.MEDIUM} LOW=${t.LOW}`);
} else {
  console.log(`Trivy image   : (no report — image not built)`);
}

const gl = read("gitleaks.json");
const glCount = Array.isArray(gl) ? gl.length : 0;
console.log(`gitleaks      : ${glCount} finding(s)`);

const had = read("hadolint.json");
const hadCount = Array.isArray(had) ? had.length : 0;
const hadBySev = {};
if (Array.isArray(had)) for (const h of had) hadBySev[h.level] = (hadBySev[h.level] || 0) + 1;
console.log(`hadolint      : ${hadCount} finding(s) ${JSON.stringify(hadBySev)}`);

const osv = read("osv.json");
let osvVulns = 0, osvPkgs = 0;
if (osv && Array.isArray(osv.results)) {
  for (const r of osv.results)
    for (const p of r.packages || []) { osvPkgs++; osvVulns += (p.vulnerabilities || []).length; }
}
console.log(`OSV-Scanner   : ${osvVulns} vuln(s) across ${osvPkgs} package(s)`);

const totalCrit = tfs.CRITICAL + (timg ? trivyTally(timg).CRITICAL : 0);
console.log("----------------------------------------------------------------------");
if (totalCrit > 0) console.log(`NOTE: ${totalCrit} CRITICAL finding(s) — these WOULD fail the CI gates.`);
else console.log("No CRITICAL findings — CI gates would pass on severity.");
NODE

echo "======================================================================"
echo "Reports in ${EVID}/ (trivy-fs.json, trivy-image.json, gitleaks.json, hadolint.json, osv.json)"
