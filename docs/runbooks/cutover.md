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
`export → import → **soak-sync (continuous catch-up while v1 is live)** → freeze →
**final reconcile (deletes applied)** → verify (HARD gate) → flip → finalize`, with
**commercial tenants first, gov tenants last** (behind the gov-go-live gate).

> **Why the soak-then-reconcile shape:** the freeze window is the only downtime, so we
> shrink it to near-zero. `soak-sync` runs on a cadence **before** the freeze, draining
> inserts/updates continuously while v1 keeps serving. The freeze then only needs to cover
> the **final reconcile** — a small last delta plus the one thing the delta can't do:
> applying the **DELETES** that happened in the source during the soak. A watermark delta is
> insert/update-only (a deleted row just stops appearing), so deleted rows **linger** in v2
> until the under-freeze reconcile removes them by an exact org-scoped PK-set diff.

The cutover is now driven by **one orchestrator** (`scripts/cutover/orchestrate.mjs`) that
sequences the whole per-tenant procedure — parity precheck → soak → freeze → reconcile →
verify-gate → flip → unfreeze — and **rolls back on any failure**. The **freeze and flip
happen at a dedicated cutover reverse proxy** (a SEPARATE Caddy from the app's
`compose/Caddyfile`) that routes by `orgSlug` to v1 or v2 and enforces the per-org
write-freeze at the edge. **§A below is the primary procedure; §2–§8 document the underlying
manual steps the orchestrator drives.**

The remaining DEFERRED-to-automation steps (automated snapshot capture/restore for the data
rollback, the soak-sync scheduler/cron, the edge DNS / Cloudflare-tunnel cutover,
provider-side Google token revoke, the exposability-map gate) are called out inline as
**manual / deferred**.

---

## A. Orchestrated cutover (the primary path) — `orchestrate.mjs`

> ## ⛔ BUILD-ONLY — `--dry-run` IS THE DEFAULT; `--confirm` IS REQUIRED TO EXECUTE ⛔
>
> The orchestrator is **safe-by-default**: with no `--confirm` it prints the plan and
> **touches nothing** (no parity run, no soak, no freeze, no reconcile, no flip). Only
> `--confirm` executes. It **rolls back on ANY failure at or after the freeze** (routes the
> org back to v1 + unfreezes + prints the snapshot-restore step + exits non-zero), so an org
> is **never left frozen or half-flipped**. Never point `--source` / `--target` /
> `--proxy-admin` at a real production stack without Step 0 green + change-approver sign-off
> + (gov) the §9 gov-go-live gate, and live coordination.

**A.0 — Stand up the cutover reverse proxy** (`compose/cutover-proxy/`, see its README). It
boots from `caddy.base.json` (admin API internal on `localhost:2019`, every org on **v1** by
default). The orchestrator drives the admin API to freeze/flip/rollback per-org. The proxy
routes by the dashboard path token `/<orgSlug>/…`; the API form `/api/v1/orgs/<id>/…` is
covered by v2's in-app freeze, not the proxy (the documented **slug-vs-id** assumption).

**A.1 — Run the orchestrator** (dry-run first, ALWAYS, to review the plan):

```sh
# DRY-RUN (default): prints the plan, touches nothing.
npx tsx scripts/cutover/orchestrate.mjs \
  --org   "<orgId-uuid>" --slug "<orgSlug>" \
  --source "$SOURCE_DATABASE_URL" --target "$TARGET_OWNER_DATABASE_URL" \
  --scratch "$SCRATCH_URL" --shadow "$SHADOW_URL" \
  --prod-schema-dump /secure/cutover/prod-schema.sql \
  --state  "/secure/cutover/<slug>/soak-state.json" \
  --proxy-admin http://<cutover-proxy-admin>:2019 \
  --v1 <v1-dial>:80 --v2 <v2-dial>:80 \
  --max-cycles 10 --stamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# EXECUTE: add --confirm (everything else identical).
npx tsx scripts/cutover/orchestrate.mjs … --confirm
```

The orchestrator sequence (each step timestamp-logged; the final line is a machine-readable
`ORCHESTRATE_REPORT {…}`):

1. **Parity-gate precheck** — runs `parity-gate.mjs` (Step 0) against the restored snapshot.
   A fail **aborts before any freeze** (nothing to roll back).
2. **Soak loop** — runs `soak-sync.mjs` repeatedly until a cycle reports **0 upserts**
   (caught up) or `--max-cycles`. (Hitting the cap is fine — the final reconcile is exact.)
3. **Freeze** — `proxy-control.freezeOrg(slug)`: writes to the org **405** at the proxy,
   reads pass. **From here, any failure triggers rollback.**
4. **Reconcile** — `reconcile-org.mjs` (final force-exact import + delete-extras + in-txn
   orphan probe; it also runs verify as its Phase-4 gate).
5. **Verify gate** — `verify-org.mjs` explicitly (the canonical rollback trigger). Any
   mismatch ⇒ **rollback**.
6. **Flip** — `proxy-control.setOrgUpstream(slug,"v2")`: the org's path now routes to v2.
7. **Unfreeze** — `proxy-control.unfreezeOrg(slug)`: writes resume, served by v2.

**Rollback (any failure at/after the freeze):** `setOrgUpstream(slug,"v1")` + `unfreezeOrg(slug)`
(the org goes back to v1, unfrozen), then the orchestrator prints the **data-restore** step.
The data rollback is the **pre-flip v1 snapshot**: v1 is the source and was **not** mutated by
the cutover and **its columns are kept intact** (§7 keeps the source credentials/columns until
finalize), so v1 itself is the live rollback — a snapshot restore of v2 is only needed if v2
already took post-flip writes. The orchestrator prints the exact pgBackRest point-in-time
restore command to run for that case.

- [ ] **Dry-run reviewed** (the printed plan matches the tenant + URLs you intend).
- [ ] Step 0 parity gate is green for the current v2 schema (the orchestrator re-checks it).
- [ ] `--confirm` run exits **0** with `ORCHESTRATE_REPORT {"ok":true,…}`; the org now serves
      v2 and writes are resumed. On a non-zero exit, read the step log: the org has been routed
      back to v1 + unfrozen, and the snapshot-restore step is printed — fix the cause and re-run.

**Commercial-first / gov-last (orchestrated):** run commercial tenants first. For a **gov**
tenant, the §9 gov-go-live gate + the per-tenant exposability-map review must be cleared
**before** that tenant's `--confirm` run (the orchestrator does not enforce the gov gate — it
is an out-of-band human sign-off that precedes the orchestrated gov flip).

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
sampled content checksum, **and a generic dangling-FK orphan probe**) and **exits non-zero
on ANY mismatch** — that clean exit is the gate the flip is conditioned on.

Two more scripts make the cutover **near-zero-downtime**: `soak-sync.mjs` is an
**incremental watermark delta replay** — while v1 is still live it repeatedly re-exports and
re-imports only the rows changed since the last cycle (per-table watermark =
`updated_at` if present, else `created_at`, else a full scan), keeping v2 caught up so the
freeze window is tiny. `reconcile-org.mjs` is the **final reconcile** run ONCE under freeze:
a final full idempotent import, then **delete-extras** (it removes from v2 the rows that were
DELETED in the now-frozen source during the soak — which the insert/update-only delta
**cannot** see), then the orphan probe + verify gate. Both reuse the same export/import cores
as the one-shot engine (`lib/export-core.ts`, `lib/import-core.ts`).

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

## 2. Freeze (source-side write-freeze) — AFTER the soak, RIGHT BEFORE the reconcile

> **Ordering:** do the initial export+import (§3-4) and run the **soak-sync** (§4b) on a
> cadence **while v1 is still live and unfrozen**. Freeze **only** once you're ready to run
> the **final reconcile** (§5). The freeze is what makes the final delta + the deletes
> consistent; it is the entire downtime window, so it should be measured in **seconds to a
> few minutes** thanks to the soak having already drained the bulk of the changes.

A short write-freeze on the org lets the last delta drain consistently. Mutating verbs
(POST/PUT/PATCH/DELETE) for a frozen org return **HTTP 405**; **reads keep working**.

> **Orchestrated path (preferred):** the **cutover reverse proxy** enforces the freeze at the
> edge — `proxy-control.freezeOrg(slug)` / `unfreezeOrg(slug)` add/remove a per-org 405 route
> via the Caddy admin API (§A). The freeze MUST be at the proxy because the **v1 (source)
> stack lacks the in-app freeze middleware** — only the proxy sits in front of v1. The
> orchestrator does this automatically (sequence step 3 / 7); you do not run the in-app
> helpers below during an orchestrated cutover.

The in-app freeze (below) is the **v2-side / API** primitive: `src/proxy.ts` returns 405 for a
frozen org's id-keyed API path. It is kept for the `/api/v1/orgs/<id>/…` surface and as a
permanent no-op-unless-frozen guard inside v2; it does **not** cover v1.

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

## 4b. Soak-sync — continuous incremental catch-up (WHILE v1 IS LIVE)

After the initial import seeds v2, keep v2 caught up with the **still-live** source by
running the incremental delta replay on a cadence. Each cycle re-exports/re-imports only the
rows changed since the last cycle, selected by a per-table watermark. The org is **NOT**
frozen during the soak — v1 keeps serving; this is the work that shrinks the freeze window.

Run as the **owner** on the target (it imports under `session_replication_role = replica`).
The `--state` file is the soak's only memory (per-table watermarks keyed by orgId); a missing
file = a full first sync.

```sh
# one cycle (drain the current delta):
npx tsx scripts/cutover/soak-sync.mjs \
  --source "$SOURCE_DATABASE_URL" \
  --target "$TARGET_OWNER_DATABASE_URL" \
  --org    "<orgId-uuid>" \
  --state  "/secure/cutover/<slug>/soak-state.json" \
  --stamp  "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# or run it as a cadence (the documented soak loop; the scheduler/cron is ops):
npx tsx scripts/cutover/soak-sync.mjs … --loop --interval 300   # every 5 min
```

- **Watermark per table:** `updated_at` if the table has one, else `created_at`, else (the
  ~11 join/config tables with neither) a **full scan every cycle** (idempotent UPSERT, so a
  full re-scan can never miss a change). The watermark advances to the **max value observed**
  in the exported rows (never a wall clock) — no clock-skew window, no skipped row.
- **The referential closure runs every cycle**, so a changed/new child pulls its global/shared
  parent in; the delta is always referentially complete.
- [ ] Each cycle prints per-table `scanned` / `upserted`. A steady-state cycle on an idle org
      is cheap (mostly 0 upserts). Re-running drains whatever changed.

> **⚠ Delta replay CANNOT see DELETES.** A row deleted in the source during the soak simply
> stops appearing in the delta, so it **lingers in v2**. This is **by design** — the soak is
> insert/update catch-up only. The lingering deletes are removed by the **final reconcile**
> (§5) under freeze. Do **not** try to make the soak delete rows; deletes are applied exactly
> once, under freeze, by the reconcile's PK-set diff.

---

## 5. Final reconcile + verify — THE HARD FLIP GATE (under freeze)

**Precondition: the source is now write-FROZEN (§2).** With the bulk already drained by the
soak, the freeze covers only this final pass. `reconcile-org.mjs` makes v2 **EXACTLY** match
the frozen source — including the deletes the delta couldn't see — then runs the verify gate.

Run as the **owner** on the target:

```sh
npx tsx scripts/cutover/reconcile-org.mjs \
  --source "$SOURCE_DATABASE_URL" \
  --target "$TARGET_OWNER_DATABASE_URL" \
  --org    "<orgId-uuid>" \
  --stamp  "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # [--confirm-large] [--large-threshold <n>]  — see the delete-count guard below
```

It runs four phases, **fail-closed** at each:

1. **Final full idempotent import (FORCE / EXACT)** — catches any last delta **and any silent
   drift the soak's last-writer-wins delta can't see**. Under freeze the source is the
   **authoritative exact state**, so mutable rows are overwritten **unconditionally** (the
   `WHERE EXCLUDED.updated_at >` guard is dropped) to make the target match the source **exactly**.
   This specifically handles a **source-side cascaded `SetNull`** that did **not** bump the child's
   `updated_at` — e.g. `work_items.parent_id` (an optional self-relation whose Prisma-default
   `onDelete` is `SetNull`): the soak delta never sees it (no `updated_at` change), so without the
   force import the target would keep a **stale `parent_id`**, the delete-extras of the parent would
   leave a **dangling self-FK**, and the orphan probe would **spuriously roll the reconcile back**.
   Force mode force-updates the child's `parent_id` to `NULL` first, so the parent delete leaves no
   dangle. **Append-only / audit** tables stay `DO NOTHING` (immutable) even under force — they are
   never overwritten. The **soak deltas use the guarded last-writer-wins path**; force applies
   **only** to this under-freeze final import.
2. **Delete-extras** — for each **mutable, org-owned (DIRECT/PARENT), non-audit** table, it
   computes the org-scoped PK set in source vs target and `DELETE`s from the target the PKs in
   **target-but-not-source** (the rows deleted in the source during soak), in **one** owner
   transaction (`session_replication_role = replica`), ordered **children-before-parents**
   (reverse FK-topological) so a parent delete never strands a retained child.
3. **Orphan probe** inside that same transaction — **any** dangling FK ⇒ the whole reconcile
   **ROLLS BACK** (all-or-nothing; a delete that would strand a child is rejected and the
   target is left untouched).
4. **Verify gate** — `verify-org` (counts now match exactly, per-row money, markings,
   checksums, orphan probe). A clean exit (0) is the flip precondition.

### The never-delete invariants (the crux — these MUST hold)

The reconcile deletes **strictly** the set `org-owned ∩ mutable ∩ non-audit`, by org-scoped
PK-set diff. It therefore **NEVER**:

- **deletes from append-only / audit tables** — immutable history; `audit_logs` /
  `egress_decisions` are also refused **by name** (defense in depth) and their DELETE trigger
  would block it anyway. v1 never deletes them, so there is nothing to reconcile.
- **deletes the referential-closure parents** — a **global built-in** (`work_item_type` /
  template with `org_id IS NULL`) or a **shared user** (incl. a user who is a member of
  **two** orgs) is not org-owned. Because the diff uses the **strict org-scope** SELECT, such
  a row is in **neither** the source-scoped nor the target-scoped PK set, so it can **never**
  be a delete candidate. Deleting a shared user because it looks "extra for this org" would
  corrupt another org — that must never happen.
- **touches another org's rows** — same org-scoped diff; DIRECT deletes also re-assert
  `org_id` in the `DELETE … WHERE` as a final safety net.

### The delete-count guard

A delete-extras count over `--large-threshold` (default **10000**) makes the reconcile
**fail-closed** unless you pass `--confirm-large`. A huge delete count is almost always a
**scoping bug**, not a real mass-deletion — investigate the per-table planned counts the
script prints before overriding.

- [ ] `reconcile-org` exits **0**. If it exits non-zero, **DO NOT FLIP** — read the failure
      (a verify mismatch, an orphan rollback, or the large-delete guard), fix the cause, and
      re-run. The reconcile is idempotent: a clean re-run reports **0 deleted**.

### verify-org standalone (the same gate the reconcile runs)

```sh
npx tsx scripts/cutover/verify-org.mjs \
  --source "$SOURCE_DATABASE_URL" \
  --target "$TARGET_DATABASE_URL" \
  --org    "<orgId-uuid>" \
  --out    "/secure/cutover/<slug>/verify-report.json"
```

The gate checks: per-model **exact** row-count match (DataClassification compared against the
deduped expected count); **per-row** money equality (PK-join; Decimal exact / Float round-4 —
never an aggregate SUM); the **CUI/FOUO marking invariant** (orgs bearing any CUI/FOUO
marking: source == target); a **sampled content checksum** over mutable rows; and the generic
**dangling-FK orphan probe**. It **exits 0 only when CLEAN** — `mismatches` is empty.

- [ ] **`verify-org` exits 0** (CLEAN). If it exits non-zero, **DO NOT FLIP** — read the
      `mismatches` array, fix the cause, re-run the reconcile, re-verify. A clean verify is
      the precondition for the flip.

---

## 6. Flip (cutover reverse-proxy route change — orchestrated)

> **Now automated at the cutover reverse proxy** (§A). The orchestrator runs
> `proxy-control.setOrgUpstream(slug, "v2")` (sequence step 6) — the per-org route's upstream
> flips from v1 to v2 via the Caddy admin API (`POST /load` of the full rewritten config:
> atomic, zero-downtime, auto-rollback on a bad config). The **edge DNS / Cloudflare-tunnel**
> cutover (pointing the public name at the cutover proxy) remains ops/deferred.

Manual equivalent (if driving the proxy directly rather than via the orchestrator):

```sh
# flip one org to v2 (idempotent):
npx tsx -e 'import("./scripts/cutover/lib/proxy-control.ts").then(async m => {
  const p = new m.ProxyControl({ adminUrl: process.env.PROXY_ADMIN,
    upstreams: { v1: process.env.V1_DIAL, v2: process.env.V2_DIAL } });
  await p.setOrgUpstream(process.env.SLUG, "v2");
  console.log(await p.getOrgState(process.env.SLUG));
})'
```

- [ ] Confirm a v2 page loads for the tenant (`GET /<slug>/…` reaches v2) and an authenticated
      write succeeds **on v2** after the unfreeze.
- [ ] Keep **v1 the read-only rollback target** until finalize so no split-brain writes land
      on v1 (the orchestrator unfreezes only after the flip, and v1 columns stay intact).

---

## 7. Finalize

The bulk catch-up (soak) and the exact reconciliation (including deletes) already happened in
§4b–§5; the flip is done. Finalize the tenant:

- [ ] **Post-flip confidence check:** watch v2 for the tenant. The reconcile already made v2
      exactly match the frozen source and the verify gate passed, so no further data sync is
      needed — but you may re-run `verify-org` for peace of mind (it must stay CLEAN).
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

> **Orchestrated rollback (automatic):** on ANY failure at/after the freeze the orchestrator
> runs `setOrgUpstream(slug,"v1")` + `unfreezeOrg(slug)` itself (the org is back on v1,
> unfrozen) and prints the data-restore step + exits non-zero. The steps below are the manual
> equivalent / the data-restore the orchestrator instructs you to perform.

- [ ] The cutover proxy routes the `orgSlug` back to **v1** (orchestrator does this; verify via
      `proxy-control.getOrgState(slug)` → `{ upstream: "v1", frozen: false }`).
- [ ] **Data restore — only if v2 took post-flip writes.** v1 was not mutated by the cutover
      and its columns are kept intact (§7), so v1 is the live rollback. If v2 received writes
      after the flip, **restore the per-tenant data from its pre-flip snapshot** (pgBackRest
      point-in-time restore for the whole-DB case; the scoped logical dump for a single org).
      The orchestrator prints the exact `pgbackrest … --type=time --target="<PRE-FLIP ts>"`
      command. Source credentials were never nulled pre-finalize, so v1 still authenticates.
- [ ] Confirm the org is healthy on v1 again (the orchestrator already unfroze it at the proxy).
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
| **orchestrate (the whole thing)** | `tsx scripts/cutover/orchestrate.mjs --org … --slug … --source … --target <owner-url> --scratch … --shadow … --prod-schema-dump … --state … --proxy-admin … --v1 … --v2 … [--max-cycles N] [--stamp …]` — **DRY-RUN by default; `--confirm` to execute; rolls back on any post-freeze failure** |
| parity (Step 0, HARD) | `tsx scripts/cutover/parity-gate.mjs --prod-schema-dump … --prod-migrations … --prod-commit … --scratch-url … --shadow-url … --stamp …` |
| export  | `tsx scripts/cutover/export-org.mjs --source … --org … --out … --stamp …` |
| import  | `tsx scripts/cutover/import-org.mjs --target <owner-url> --in … --org …` |
| soak-sync (cadence, v1 live) | `tsx scripts/cutover/soak-sync.mjs --source … --target <owner-url> --org … --state … [--loop --interval <sec>] --stamp …` |
| freeze (at the cutover proxy) | `proxy-control.freezeOrg(slug)` (orchestrated) / in-app `freezeOrg(orgId, orgSlug, …)` for the API path |
| final reconcile (under freeze, applies DELETES) | `tsx scripts/cutover/reconcile-org.mjs --source … --target <owner-url> --org … --stamp … [--confirm-large]` |
| verify  | `tsx scripts/cutover/verify-org.mjs --source … --target … --org … --out …` |
| flip (at the cutover proxy) | `proxy-control.setOrgUpstream(slug, "v2")` (orchestrated; edge DNS/tunnel deferred) |
| rollback (orchestrated) | `setOrgUpstream(slug,"v1")` + `unfreezeOrg(slug)` + restore pre-flip snapshot if v2 took writes |
| synthetic acceptance | `npm run cutover:acceptance-orchestrate` (proxy + v1/v2 stubs + reconcile + rollback; no prod) · `npm run cutover:soak-acceptance` (soak+reconcile) |
