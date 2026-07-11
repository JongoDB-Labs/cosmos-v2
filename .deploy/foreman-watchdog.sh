#!/usr/bin/env bash
# Fires the app's Foreman down-alert when the daemon heartbeat goes stale.
# Alert only on the fresh->stale TRANSITION (state file) — the endpoint also
# dedupes 6h server-side, so a flapping timer cannot spam.
set -euo pipefail
: "${DATABASE_URL:?}" "${FOREMAN_ALERT_TOKEN:?}" "${ALERT_URL:=http://127.0.0.1:8090/api/foreman/alert}"
STATE=/var/tmp/foreman-watchdog.state
# Deliberate stops are not incidents: if the unit is cleanly inactive (ship
# pipelines stop the daemon for 15-25 min by design), skip the staleness alert
# entirely. A crashed daemon reads "failed"; a wedged one reads "active" with a
# stale heartbeat — both still alert.
if [ "$(systemctl is-active foreman 2>/dev/null)" = "inactive" ]; then
  echo 1 > "$STATE"
  exit 0
fi
LAST=$(psql "$DATABASE_URL" -tAc "SELECT extract(epoch FROM last_pass_at) FROM foreman_state WHERE id='host'" 2>/dev/null || echo "")
NOW=$(date +%s)
FRESH=1
if [ -z "$LAST" ] || [ $((NOW - ${LAST%.*})) -ge 600 ]; then FRESH=0; fi
PREV=$(cat "$STATE" 2>/dev/null || echo 1)
echo "$FRESH" > "$STATE"
if [ "$FRESH" = 0 ] && [ "$PREV" = 1 ]; then
  ISO=$([ -n "$LAST" ] && date -u -d "@${LAST%.*}" +%Y-%m-%dT%H:%M:%SZ || echo "")
  curl -fsS -m 10 -X POST "$ALERT_URL" \
    -H "Authorization: Bearer $FOREMAN_ALERT_TOKEN" -H "Content-Type: application/json" \
    -d "{\"check\":\"stale\"${ISO:+,\"lastPassAt\":\"$ISO\"}}" || true
fi
