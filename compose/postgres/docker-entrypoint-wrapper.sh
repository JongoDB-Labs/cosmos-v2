#!/bin/bash
# Entrypoint wrapper for the cosmos postgres image. Renders the pgBackRest config from
# env (secrets stay out of the image), then hands off to the stock postgres entrypoint
# UNCHANGED — which drops privileges to the postgres user and runs the compose
# `command:` (postgres -c archive_mode=on ...). archive_command then shells out to
# `pgbackrest archive-push`, which reads the rendered /etc/pgbackrest/pgbackrest.conf.
set -euo pipefail

# Only render if the repo creds are present (they always are in this stack); skip
# loudly otherwise so a misconfig is visible rather than silently archiving nowhere.
if [ -n "${PGBACKREST_REPO1_S3_KEY:-}" ]; then
  /usr/local/bin/render-pgbackrest-conf.sh
else
  echo "WARN: PGBACKREST_REPO1_S3_KEY unset — pgBackRest config NOT rendered; archive_command will fail." >&2
fi

# Hand off to the original postgres entrypoint (path is stable across pg16 images).
exec docker-entrypoint.sh "$@"
