# Runbook: Per-Tenant Cutover (v1 → v2 migration)

> ## ⛔ BUILD-ONLY — DO NOT RUN AGAINST PRODUCTION WITHOUT SIGN-OFF ⛔
>
> The cutover engine (`scripts/cutover/*`) and this procedure are **built and
> synthetic-tested only**. **No step here may be pointed at a live production
> database** until:
> 1. the §9.2 reconciled-baseline parity gate is green for the target schema, AND
> 2. a named change-approver has signed off on **this specific tenant's** cutover, AND
> 3. (for **gov** tenants) the §6 gov-go-live gate + the §9.3-step-9 exposability-map
>    review have been cleared.
>
> The export script is read-only; the import script writes as the DB **owner** with
> FK/trigger suppression. Treat `--target` as a loaded weapon: a wrong `--org` or a
> wrong URL writes the wrong tenant. Every script re-checks the orgId against the
> manifest and refuses cross-org rows, but the human running it is the last guard.

How COSMOS migrates **one tenant at a time** from v1 (the source app + its DB) to v2
(the new stack + its dedicated DB), with **zero row loss, exact money, preserved CUI
markings, and idempotent replay**. The model is **unidirectional, per-tenant**
`freeze → export → import → verify (HARD gate) → flip → soak → finalize`, with
**commercial tenants first, gov tenants last** (behind the gov-go-live gate).

This runbook is the **first delivered slice**: the core engine + the source-side
write-freeze. The DEFERRED-to-automation steps (snapshot/provenance reconstruction,
the soak-sync scheduler, the automated reverse-proxy flip, provider-side Google token
revoke, the exposability-map gate) are called out inline as **manual / deferred**.

---

## 0. The engine, in one paragraph

`export-org.mjs` reads ONE org's rows from the source (org-strict, schema-derived from
the Prisma DMMF — `scripts/cutover/lib/model-graph.ts`), strips DB-computed columns
(`content_tsv`, the legacy `search_vector`, the pgvector `embedding`), and writes a
lossless NDJSON-per-table export + a manifest. `import-org.mjs` replays that export into
v2 in **one owner transaction** under `session_replication_role = replica` (FK-safe bulk
load), **idempotently** (append-only ⇒ `ON CONFLICT DO NOTHING`; mutable ⇒
`DO UPDATE … WHERE EXCLUDED.updated_at > target.updated_at`), de-duplicating the
`DataClassification` org-ceiling rows fail-closed (keep the highest level, markings
verbatim, every drop logged). `verify-org.mjs` then compares source↔target
(per-model exact counts, **per-row** money equality, the CUI/FOUO marking invariant, a
sampled content checksum) and **exits non-zero on ANY mismatch** — that clean exit is the
gate the flip is conditioned on.

---

## Step 0. Schema-parity gate — HARD, before any freeze

> **This is a HARD §9.2 prerequisite for the WHOLE cutover programme, not just one
> tenant.** It runs **once per v2 schema revision** (re-run whenever either prod's
> schema or v2's `prisma/schema.prisma` changes), and it must be **green before any
> tenant is frozen**. A non-empty diff **or** a missing classification FK **BLOCKS every
> cutover** until the v2 schema / baseline is reconciled.

The cutover engine migrates tenant data into v2's schema. That is only trustworthy if
v2's schema is **structurally identical to what production actually runs**. This gate
proves it and records prod provenance into `compliance/provenance/prod-baseline.json`.

It runs against a **RESTORED snapshot in a throwaway scratch DB — NEVER against live
prod.** The only thing taken from prod is a schema-only dump + the migration history
(no tenant rows).

**0a. Capture from prod (out-of-band, schema only):**

```sh
# Schema only — NO tenant data leaves prod here.
pg_dump --schema-only "$PROD_DATABASE_URL" > /secure/cutover/prod-schema.sql

# Prod's applied-migration history (for the provenance fingerprint):
psql "$PROD_DATABASE_URL" --csv -c \
  "SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name" \
  > /secure/cutover/prod-migrations.csv

# And note the prod git commit the deploy is on (rev-parse on the prod checkout).
```

**0b. Run the gate against a RESTORED scratch DB:**

```sh
npx tsx scripts/cutover/parity-gate.mjs \
  --prod-schema-dump /secure/cutover/prod-schema.sql \
  --prod-migrations  /secure/cutover/prod-migrations.csv \
  --prod-commit      "<prod-git-sha>" \
  --scratch-url      "postgres://cosmos:cosmos@localhost:5599/scratch" \
  --shadow-url       "postgres://cosmos:cosmos@localhost:5600/shadow" \
  --stamp            "$(date -u +%Y-%m-%dT%H:%M:%SZ)"   # stamp is a CLI arg on purpose
```

Two throwaway Postgres are needed: `--scratch-url` (the gate restores the prod dump here)
and `--shadow-url` (Prisma RESETS this and replays `prisma/migrations` here to build v2's
reference schema — it must be a different, disposable DB).

The script (1) ensures `pgcrypto`+`pgvector` and restores the dump into the scratch DB,
then runs the **two-part gate**:

1. **Parity** — `prisma migrate diff` between the restored snapshot and v2's REAL schema
   (what `prisma/migrations` produces, replayed into the shadow DB — NOT the lossy
   `schema.prisma` datamodel, which omits raw-SQL-only objects) must be **EMPTY**. A
   non-empty diff is captured (SQL) and the gate FAILS.
2. **Classification FK** — the snapshot must carry the FK
   `data_classifications.project_id → projects.id` (the §9.2 baseline marker proving the
   snapshot came from the classification-propagation line). Missing ⇒ FAIL.

On success it writes `compliance/provenance/prod-baseline.json` (`prodCommit`,
`migrationHistoryHash`, `migrationCount`, `parityGate: "pass"`, `classificationFk: true`,
`checkedAt`) and exits 0.

- [ ] **The gate exits 0** (PASS). If it exits non-zero, **DO NOT proceed to any tenant
      cutover.** A non-empty diff means v2's schema must be reconciled to prod (or vice
      versa); a missing classification FK means the snapshot is not the reconciled
      baseline. Fix the cause, re-run the gate, and only then continue.
- [ ] The provenance record is committed (`compliance/provenance/prod-baseline.json`) so
      the cutover's source-of-truth is auditable.
- [ ] **Scratch DB + the prod schema dump are destroyed/secured after the run** (the dump
      is schema-only, but treat it as sensitive infra detail). Never leave the scratch DB
      reachable.

See `compliance/provenance/README.md` for field meanings and the hash semantics.

---

## 1. Pre-flight (per tenant)

- [ ] The target v2 DB is up with the `0000_init` superset migrations applied (incl.
      `pgcrypto` + `pgvector`), and **its `_prisma_migrations` was stamped via
      `migrate resolve --applied` — never copied from prod**.
- [ ] You have the tenant's `orgId` (UUID) and `orgSlug`. Double-check both.
- [ ] Money: confirm the source has applied `money_float_to_decimal` in a **prior**
      deploy (verify supports a Float source via round-4, but Decimal-on-Decimal is the
      expected, exact path).
- [ ] A pre-flip **snapshot** of the source org exists (for rollback). For the whole-DB
      case this is the pgBackRest base backup; for a single org, a scoped logical dump.
- [ ] Change-approver sign-off recorded (see the banner). Gov: gates cleared.

---

## 2. Freeze (source-side write-freeze)

A short write-freeze on the org in the **source** app lets the last delta drain
consistently. The proxy (`src/proxy.ts`) returns **HTTP 405** on mutating verbs
(POST/PUT/PATCH/DELETE) for a frozen org; **reads keep working**.

Freeze / unfreeze via the helpers in `src/lib/cutover/freeze.ts` (run in an app context,
e.g. a one-off `tsx` script or an ops console):

```ts
import { freezeOrg, unfreezeOrg, isOrgFrozen } from "@/lib/cutover/freeze";
await freezeOrg(orgId, orgSlug, { reason: "cutover", frozenBy: "alice@…" });
await isOrgFrozen(orgSlug); // → true
// … later, on rollback or after finalize …
await unfreezeOrg(orgId);
```

Or directly in SQL (the table is `frozen_orgs`, keyed by both `org_id` and `org_slug`):

```sql
INSERT INTO frozen_orgs (org_id, org_slug, reason, frozen_by)
VALUES ('<uuid>', '<slug>', 'cutover', '<who>')
ON CONFLICT (org_id) DO UPDATE SET reason = EXCLUDED.reason, frozen_by = EXCLUDED.frozen_by;
```

- [ ] Freeze the org. Confirm a write returns **405** and a read returns **200**.
- [ ] Keep the freeze window SHORT — every v2-side write made after the export but before
      the flip is in the frozen window, and rollback (§7) accepts the loss of writes in
      that window. That is *why* the window is write-frozen.

---

## 3. Export (read-only, from a consistent snapshot)

Export the org from a **consistent snapshot** of the source — a restored point-in-time
dump into a scratch DB, or the live source AFTER the freeze (a moving source is the only
thing the freeze is protecting against). The script wraps the read in a
`REPEATABLE READ READ ONLY` transaction for a self-consistent multi-table copy.

```sh
npx tsx scripts/cutover/export-org.mjs \
  --source "$SOURCE_DATABASE_URL" \
  --org    "<orgId-uuid>" \
  --out    "/secure/cutover/<slug>" \
  --stamp  "$(date -u +%Y-%m-%dT%H:%M:%SZ)"   # stamp is a CLI arg on purpose
```

Produces `/secure/cutover/<slug>/manifest.json` + `tables/<table>.ndjson`.

- [ ] Review the manifest `totalRows` and per-table counts look sane for this tenant.
- [ ] The export directory contains tenant data — store it on encrypted, access-controlled
      media; delete it after finalize.

---

## 4. Import (idempotent replay, as the OWNER)

Run as the **owner** role (`cosmos`) — it needs `session_replication_role` + full DML.
**NOT** `cosmos_app` (least-privilege; the import will fail trying to set the replication
role, which is the intended guard).

```sh
npx tsx scripts/cutover/import-org.mjs \
  --target "$TARGET_OWNER_DATABASE_URL" \
  --in     "/secure/cutover/<slug>" \
  --org    "<orgId-uuid>"
```

- [ ] Read the structured result: `inserted / updated / skipped` per table + the
      `dedupDrops` (any `DataClassification` ceiling duplicates dropped, with the kept vs
      dropped level + the dropped markings — **review these**: the survivor keeps the
      HIGHEST level and its own markings verbatim; a dropped row's markings are logged so
      you can confirm nothing was silently lost).
- [ ] **Re-run the import** — it MUST report **0 inserted / 0 updated** (idempotent). This
      is also exactly the soak-sync primitive: re-running drains new deltas.

### Note: imported audit rows are NULL-`row_hash` (legacy) — by design

Under `session_replication_role = replica` the audit append-only + hash-chain
`BEFORE INSERT` triggers do **not** fire, so imported `audit_logs` / `egress_decisions`
rows arrive with `row_hash = NULL`. `verify_audit_chain()` scopes the chain to
`row_hash IS NOT NULL`, so these migrated-history rows are treated as **pre-chain legacy**
— consistent with how the hash-chain migration handles any pre-2.6.0 rows. The migrated
history is anchored by the **source's** offsite WORM export, not re-chained on import;
**new** post-cutover rows chain normally from a fresh genesis. (See
`docs/runbooks/audit-integrity.md`.) Do not "fix" this by re-hashing on import — it would
fabricate a chain over rows the source already attested.

---

## 5. Verify — THE HARD FLIP GATE

```sh
npx tsx scripts/cutover/verify-org.mjs \
  --source "$SOURCE_DATABASE_URL" \
  --target "$TARGET_DATABASE_URL" \
  --org    "<orgId-uuid>" \
  --out    "/secure/cutover/<slug>/verify-report.json"
```

- Per-model **exact** row-count match (DataClassification compared against the deduped
  expected count).
- **Per-row** money equality (PK-join; Decimal exact / Float round-4) — never an aggregate
  SUM.
- The **CUI/FOUO marking invariant** (orgs bearing any CUI/FOUO marking: source == target).
- A **sampled content checksum** over mutable rows.

- [ ] **`verify-org` exits 0** (CLEAN). If it exits non-zero, **DO NOT FLIP** — read the
      `mismatches` array, fix the cause, re-import, re-verify. A clean verify is the
      precondition for the flip.

---

## 6. Flip (MANUAL reverse-proxy route change — deferred automation)

> **Deferred:** the automated reverse-proxy flip + DNS is a later slice. For now this is a
> documented manual step.

Point the tenant's route at v2:

- Edit the reverse proxy (Caddy/nginx) so requests for this `orgSlug` (host or path) route
  to the **v2** stack instead of v1. Reload the proxy.
- [ ] Confirm a v2 page loads for the tenant and an authenticated write succeeds **on v2**.
- [ ] **Unfreeze** is NOT yet done — keep v1 frozen during soak so no split-brain writes
      land on v1.

---

## 7. Soak + finalize

- [ ] **Soak:** watch v2 for the tenant. The import engine IS the replay primitive — if
      you took the export before the freeze, re-run export→import to drain the final delta
      (idempotent), then re-verify. (The standalone soak-sync scheduler is **deferred**.)
- [ ] **Credential re-vaulting — COPY, not move (deferred automation):** copy each
      plaintext credential into the v2 vault; **keep the source columns intact** so v1
      stays a working rollback target. NULL the source columns **only after** finalize.
- [ ] **Provider-side revoke (deferred automation):** after finalize, revoke the migrated
      Google refresh tokens provider-side (a copied-then-nulled token is still live at
      Google). Note: a rollback past the provider's token-rotation window needs user
      re-consent.
- [ ] **Finalize:** once the tenant is confirmed healthy on v2 and the soak window has
      passed with approver sign-off — remove the source-side route, NULL the copied source
      credentials, and securely delete the export directory. The tenant is now v2-only.

---

## 8. Rollback (within the frozen window)

Rollback is safe **because** the window is write-frozen — you accept the loss of any
v2-side writes made in that short window.

- [ ] Re-route the `orgSlug` back to **v1** on the reverse proxy; reload.
- [ ] **Restore the org from its pre-flip snapshot** (pgBackRest restore for the whole-DB
      case; the scoped logical dump for a single org). Source credentials were never
      nulled pre-finalize, so v1 still authenticates.
- [ ] `unfreezeOrg(orgId)` on v1 once the tenant is confirmed working there again.
- [ ] Record the rollback + cause. Do not retry the cutover until the cause is fixed and
      re-verified in a synthetic run.

---

## 9. Commercial-first / gov-last

- **Commercial** tenants cut over first (lower blast radius, the model may be invoked
  during soak).
- **Gov** tenants cut over **last**, behind the §6 gov-go-live gate. For gov, shadow the
  **data layer only** during soak — **never invoke the model for gov orgs during soak** —
  and clear the §9.3-step-9 exposability-map review + leak-test sign-off **per gov tenant**
  before that tenant's flip.

---

## Appendix — quick command reference

| step    | command |
|---------|---------|
| parity (Step 0, HARD) | `tsx scripts/cutover/parity-gate.mjs --prod-schema-dump … --prod-migrations … --prod-commit … --scratch-url … --shadow-url … --stamp …` |
| freeze  | `freezeOrg(orgId, orgSlug, …)` / SQL insert into `frozen_orgs` |
| export  | `tsx scripts/cutover/export-org.mjs --source … --org … --out … --stamp …` |
| import  | `tsx scripts/cutover/import-org.mjs --target <owner-url> --in … --org …` |
| verify  | `tsx scripts/cutover/verify-org.mjs --source … --target … --org … --out …` |
| flip    | manual reverse-proxy route change (deferred automation) |
| rollback| re-route to v1 + restore pre-flip snapshot + `unfreezeOrg(orgId)` |
