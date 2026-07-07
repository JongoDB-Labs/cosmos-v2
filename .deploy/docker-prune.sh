#!/usr/bin/env bash
# ============================================================================
# COSMOS v2 — periodic Docker cleanup for the deploy host.
#
# The pull-only deploy model (docker compose pull digest-pinned GHCR images)
# leaves the PREVIOUS release's images behind on every deploy — app + migrate,
# a few hundred MB each. Unchecked, they fill the disk and the NEXT deploy dies
# mid-pull with "no space left on device" (this actually happened at v2.153.0,
# with 54 GB of stale images and the root FS at 100%).
#
# This removes UNUSED images (and build cache) older than the retention window.
# What it will NOT remove:
#   - images referenced by a RUNNING container (the live stack is always safe,
#     regardless of age);
#   - anything newer than RETENTION (a short rollback window stays local — and
#     even a pruned image is re-pullable from GHCR, so nothing is truly lost);
#   - volumes (data) — never touched.
#
# Installed as a daily cron via /etc/cron.d/cosmos-docker-prune (runs as root).
# Safe to run by hand any time:  sudo bash .deploy/docker-prune.sh
# ============================================================================
set -uo pipefail

RETENTION="${COSMOS_PRUNE_RETENTION:-48h}"   # keep unused images newer than this
LOG="${COSMOS_PRUNE_LOG:-/var/log/cosmos-docker-prune.log}"
# Free-space floor: if the root FS is already above this %, prune ALL unused
# images (ignore the retention window) to recover fast.
EMERGENCY_PCT="${COSMOS_PRUNE_EMERGENCY_PCT:-90}"

# Prefer sudo only when not already root (cron runs as root; manual runs may not).
DOCKER="docker"
[ "$(id -u)" -ne 0 ] && DOCKER="sudo docker"

{
  echo "=== $(date -u +%FT%TZ) docker prune (retention=$RETENTION) ==="

  used_pct="$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')"
  echo "-- before -- disk ${used_pct:-?}% used"
  $DOCKER system df 2>/dev/null | sed 's/^/   /'

  if [ -n "${used_pct:-}" ] && [ "$used_pct" -ge "$EMERGENCY_PCT" ]; then
    echo "!! disk ${used_pct}% >= ${EMERGENCY_PCT}% — emergency: pruning ALL unused images"
    $DOCKER image prune -a -f 2>&1 | tail -2 | sed 's/^/   /'
  else
    $DOCKER image prune -a -f --filter "until=${RETENTION}" 2>&1 | tail -2 | sed 's/^/   /'
  fi
  # Build cache is normally empty on a pull-only host, but clear any stragglers.
  $DOCKER builder prune -f --filter "until=${RETENTION}" 2>&1 | tail -1 | sed 's/^/   /'

  echo "-- after  -- disk $(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')% used"
} >> "$LOG" 2>&1

# Keep the log itself bounded.
if [ -f "$LOG" ]; then
  tail -n 800 "$LOG" > "${LOG}.tmp" 2>/dev/null && mv "${LOG}.tmp" "$LOG" 2>/dev/null || true
fi
