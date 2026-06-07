# Cutover provenance — the §9.2 schema-parity baseline

This directory records the **provenance of the production schema** that a v2 tenant
cutover migrates from, and the verdict of the **schema-parity HARD gate** that must pass
before ANY tenant is cut over.

> **`prod-baseline.json` in this directory is an EXAMPLE / TEMPLATE.** Its fields are
> `null`/placeholder and `parityGate` is `"fail"` on purpose. It is **not** an
> attestation. The real record is produced — and this file overwritten — by running
> `scripts/cutover/parity-gate.mjs` against a **restored** production schema snapshot at
> cutover time.

## Why this exists (§9.2)

The v2 cutover engine (`scripts/cutover/{export,import,verify}-org.mjs`) migrates one
tenant's data into v2's schema. That is only trustworthy if v2's schema is **structurally
identical to what production actually runs** — not to some branch we *think* prod runs.
Production runs the classification-propagation line (per-project `DataClassification`),
and history includes a baseline that was reconciled across divergent branches. So before
the first cutover we must **prove parity** and **record what we proved it against**.

This is a **HARD prerequisite**: a non-empty schema diff, or a missing classification FK,
**BLOCKS** every cutover until the v2 schema / baseline is reconciled. It is the first
cutover-readiness gate, and it precedes soak-sync and the reverse-proxy flip.

## The two-part gate

1. **Parity** — `prisma migrate diff` between the restored prod snapshot and v2's **real**
   schema must be **EMPTY**. v2's real schema is built by replaying `prisma/migrations` into
   a throwaway shadow DB (`--to-migrations` + `--shadow-database-url`), **not** read from
   `prisma/schema.prisma`: the datamodel deliberately omits raw-SQL-only objects (the audit
   `seq` BIGINT GENERATED IDENTITY, the GENERATED `content_tsv` column, the pgvector HNSW
   indexes, the hash-chain trigger/state objects, `audit_chain_head`), so a datamodel diff is
   non-empty even on a true match. The migrations replay reproduces those objects, so an
   exact prod match diffs EMPTY. Any difference means prod's real schema is not what v2's
   migrations produce.
2. **Classification FK** — the restored snapshot must carry the foreign key
   `data_classifications.project_id → projects.id`. Its presence proves the baseline was
   reconciled from the classification-propagation line (per-project classification), not
   an older branch that predates it. (v2 declares this FK in migration
   `20260606140000_data_classification_project_fk`, so a reconciled prod and v2 diff clean.)

Both must pass or the gate exits non-zero (fail-closed).

## How the record is produced (at cutover)

Run against a **RESTORED** snapshot in a scratch DB — **never against live prod**:

```sh
# 1. Out-of-band, capture from prod (schema only — no tenant rows):
#      pg_dump --schema-only "$PROD_URL" > prod-schema.sql
#      psql "$PROD_URL" --csv -c \
#        "SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name" \
#        > prod-migrations.csv
#    and note the prod git commit SHA.

# 2. Run the gate against TWO throwaway Postgres (scratch = restore the dump; shadow =
#    Prisma replays prisma/migrations to build v2's reference schema — reset by Prisma):
npx tsx scripts/cutover/parity-gate.mjs \
  --prod-schema-dump prod-schema.sql \
  --prod-migrations  prod-migrations.csv \
  --prod-commit      "$(git -C /path/to/prod/checkout rev-parse HEAD)" \
  --scratch-url      "postgres://cosmos:cosmos@localhost:5599/scratch" \
  --shadow-url       "postgres://cosmos:cosmos@localhost:5600/shadow" \
  --stamp            "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

On success the gate writes `prod-baseline.json` here and exits 0. On any failure it exits
non-zero and the cutover is blocked.

## Fields

| field                  | meaning |
|------------------------|---------|
| `prodCommit`           | the prod git commit SHA the schema dump was taken at (`null` if not supplied) |
| `migrationHistoryHash` | stable sha256 over prod's ordered `(migration_name, checksum)` `_prisma_migrations` history — a fingerprint of exactly which migrations prod has applied (`null` if no migrations export supplied) |
| `migrationCount`       | number of applied prod migrations (`null` if no export) |
| `parityGate`           | `"pass"` only if **both** gate parts passed; otherwise `"fail"` |
| `classificationFk`     | `true` iff the `data_classifications.project_id → projects.id` FK exists in the restored snapshot |
| `checkedAt`            | the ISO-8601 timestamp passed to the gate (caller-supplied; the script takes no internal clock) |

The `migrationHistoryHash` is **order-independent** (rows are sorted by migration name)
and **collision-proof** (length-prefix framing), and excludes per-environment fields
(`applied_at`, logs) so the same prod history always yields the same hash. A different
hash at a later check means prod's applied-migration set changed.
