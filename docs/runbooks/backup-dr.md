# Runbook: Backup & Disaster Recovery (CP-9 / CP-10, NIST 800-171 3.8.9)

PostgreSQL backup/DR for COSMOS v2 using **pgBackRest** with a **native S3 repo** that
points at the in-boundary **MinIO** object store (`cosmos-pgbackrest` bucket). WAL
archiving gives point-in-time recovery (PITR); scheduled base backups bound restore
time. The repo is **encrypted at rest** (AES-256-CBC, repo cipher) independent of the
object store's own encryption.

> **Gov note.** In a gov deployment the repo points at **GovCloud / Assured-Workloads
> S3** instead of MinIO — the S3 API is identical, so only `repo1-s3-endpoint`,
> `repo1-s3-uri-style`, the TLS verification (`repo1-storage-verify-tls=y`), and the
> credentials change (see `compose/postgres/pgbackrest.conf.template`). The repo cipher
> pass and the S3 keys MUST be injected as orchestrator secrets, never plaintext env.

## Targets

| Metric | Target | How it's met |
| ------ | ------ | ------------ |
| **RPO** | **≤ 5 minutes** | Continuous WAL archiving (`archive_mode=on`, `archive_command=pgbackrest archive-push`) plus `archive_timeout=300` forces a WAL segment switch at least every 5 min even when idle, so at most ~5 min of writes are unrecovered. |
| **RTO** | **≤ 1 hour** | Latest base backup + WAL replay. Restore-drill measures the real wall-clock; for the demo dataset it is minutes. Keep a recent **full** so replay distance stays small. |

## Components

- `compose/postgres/Dockerfile` — `pgvector/pgvector:pg16` (pinned by digest) + `pgbackrest`.
- `compose/postgres/pgbackrest.conf.template` — repo1 = S3→MinIO, `repo1-cipher-type=aes-256-cbc`, `repo1-retention-full=4`, zstd compression, async WAL archiving. Secrets are substituted from env at container start by `render-pgbackrest-conf.sh` (nothing sensitive is baked into the image).
- `cosmos-postgres` service `command:` sets `archive_mode=on`, `archive_command`, `wal_level=replica`, `archive_timeout=300`, and a shared `unix_socket_directories` so the backup one-shot can reach PG locally.
- `cosmos-backup` (compose profile `ops`) — one-shot periodic backup.
- `scripts/dsop/restore-drill.sh` — the CP-10 tested-restore evidence.

The pgBackRest repo creds are the **same least-privilege MinIO key** as the app's
uploads key, scoped (by the `cosmos-app-rw` MinIO policy) to `cosmos-uploads` +
`cosmos-pgbackrest` only — it has **no** access to the object-locked `cosmos-audit-worm`
bucket.

## First-run: create the stanza + initial full backup

After `docker compose up -d` (MinIO healthy, buckets created, postgres healthy):

```bash
# One helper does stanza-create + enables WAL archiving + takes the first FULL backup.
sudo docker compose exec -u postgres cosmos-postgres \
  /usr/local/bin/cosmos-stanza-create.sh
```

The helper runs `pgbackrest --stanza=cosmos stanza-create`, then touches
`/var/lib/pgbackrest/.stanza-ready` — the local marker that flips
`compose/postgres/pgbackrest-archive-push.sh` from skip→push (see below) — then takes the initial
FULL backup and prints `pgbackrest info`.

**Why the marker / why archiving is gated:** the official postgres image runs a
temporary server during first-boot bootstrap, BEFORE the stanza exists. With
`archive_mode=on`, Postgres won't finish that bootstrap until `archive_command` returns;
a real `pgbackrest archive-push` (which must reach the repo) blocks bootstrap so the
cluster never starts. `pgbackrest-archive-push.sh` therefore exits 0 (skips, no S3 call) until the
marker is present, then does real async pushes. The pre-stanza window is operator-bounded
(stanza-create is step one) — not a steady-state RPO gap. Equivalent manual form:

```bash
sudo docker compose exec -u postgres cosmos-postgres pgbackrest --stanza=cosmos stanza-create
sudo docker compose exec -u postgres cosmos-postgres touch /var/lib/pgbackrest/.stanza-ready
sudo docker compose exec -u postgres cosmos-postgres pgbackrest --stanza=cosmos --type=full backup
```

## Backup schedule

Run these on the host cron / orchestrator scheduler (the `cosmos-backup` one-shot reads
`PGBACKREST_BACKUP_TYPE`):

| Cadence | Type | Command |
| ------- | ---- | ------- |
| Weekly (Sun 02:00) | full | `PGBACKREST_BACKUP_TYPE=full docker compose run --rm cosmos-backup` |
| Daily (02:00) | incr | `docker compose run --rm cosmos-backup` (defaults to `incr`) |

WAL is archived **continuously** (not on this schedule) — that is what bounds RPO.
`repo1-retention-full=4` keeps ~1 month of restore points; the WAL needed to make an
expired full consistent is auto-pruned with it.

Example crontab on the Docker host:

```cron
0 2 * * 0  cd /opt/cosmos-v2 && PGBACKREST_BACKUP_TYPE=full docker compose run --rm cosmos-backup >> /var/log/cosmos-backup.log 2>&1
0 2 * * 1-6 cd /opt/cosmos-v2 && docker compose run --rm cosmos-backup >> /var/log/cosmos-backup.log 2>&1
```

## Restore drill (CP-10 tested restore)

`scripts/dsop/restore-drill.sh` restores the **latest** backup into a **scratch**
container + scratch volume (the live cluster is never touched), starts it, and runs a
verification query (row counts; **asserts `audit_logs` is present**). It tears the
scratch resources down at the end.

```bash
scripts/dsop/restore-drill.sh
# ... ends in either:
#   RESTORE-DRILL: PASS — scratch cluster restored from MinIO repo, audit_logs present...
#   RESTORE-DRILL: FAIL (...)
```

Run the drill on every release and at least monthly in steady state; archive the
console output as CP-10 evidence.

### Point-in-time recovery (PITR)

To recover the **live** cluster to a specific time (e.g., just before a bad migration):

```bash
# Stop postgres, then restore with a recovery target:
sudo docker compose stop cosmos-postgres
sudo docker compose run --rm --entrypoint bash cosmos-postgres -lc '
  /usr/local/bin/render-pgbackrest-conf.sh &&
  gosu postgres pgbackrest --stanza=cosmos --delta \
    --type=time "--target=2026-06-06 12:00:00+00" restore'
sudo docker compose start cosmos-postgres   # recovers + promotes
```

## Disaster scenarios

| Scenario | Action |
| -------- | ------ |
| Bad data / dropped table | PITR to just before the event (above). |
| Datadir corruption / lost volume | Fresh volume → `--delta restore` of the latest backup → WAL replay to end. |
| Lost Postgres host | Bring up a new host on the network → restore from the MinIO repo (RTO ≤ 1 hr). |
| **Lost repo cipher pass** | Backups are **unrecoverable**. The pass MUST be escrowed in the org secret store. |

## Single-site caveat & follow-on (DR completeness)

The MinIO repo is **single-site** today: it survives loss of the Postgres host but
**not** loss of the storage site itself. Documented follow-on for full DR:

- **Offsite replication** of the `cosmos-pgbackrest` bucket — MinIO site-replication / bucket
  replication to a second region (or, in gov, GovCloud cross-region S3 replication). Until
  then the stated RPO/RTO assume the repo survives the event.
- A second pgBackRest repo (`repo2`) at a different site is the pgBackRest-native way to
  achieve the same (multi-repo backups), and is the recommended prod shape.

This is tracked as the cross-site/offsite-replication follow-on in the backup-DR phase
handoff (alongside secret rotation IA-5 and observability SI-4).
