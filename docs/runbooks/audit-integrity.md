# Runbook: Audit Integrity (AU-9 tamper-evidence, NIST 800-171 3.3.8)

How COSMOS v2 makes any post-hoc tampering with the audit trail **detectable**, how to
**verify** it, and the operational constraints (WORM anchoring, retention-purge
checkpointing) that keep that guarantee true over time.

The audit trail is two append-only tables: `audit_logs` (AC/AU general audit) and
`egress_decisions` (the AC-4 information-flow / CUI-egress decision log). Tamper-evidence
is **defense in depth, three layers**:

1. **Prevention — append-only guards** (migration `20260606050000_audit_immutability`).
   `BEFORE UPDATE/DELETE/TRUNCATE` triggers raise `42501` for **everyone, including the
   owner**; the `cosmos_app` app role is additionally `REVOKE`d `UPDATE/DELETE/TRUNCATE`.
   Nothing in the running system can mutate or remove an audit row.
2. **In-DB detection — cryptographic hash-chain** (migration `20260606070000_audit_hash_chain`,
   this runbook). Each row carries a `row_hash` that binds the previous row's hash plus this
   row's content. Tampering that is only possible by **first disabling the layer-1 guards**
   (an attacker with owner/superuser) still breaks the chain and is **detectable in-DB**.
3. **Offsite immutable anchor — WORM export** (`scripts/audit-worm-export.mjs`). Periodically
   ships both tables to an object-locked (MinIO COMPLIANCE) `cosmos-audit-worm` bucket with a
   signed sha256 manifest. Even an attacker who tampers the DB **and** forges a clean
   hash-chain is caught by diffing against the offsite copy they cannot alter.

This runbook covers layer 2 and its relationship to layers 1 and 3.

---

## 1. What the hash-chain proves

Every inserted row gets, via a `BEFORE INSERT` trigger, two byte columns:

- `prev_hash` — the chain head it bound to (the prior row's `row_hash`); `NULL` only for the
  **genesis** row (the first row inserted into the chain — see *legacy rows* below for what
  "first" means on an upgraded, non-fresh DB).
- `row_hash` — `sha256( prev_hash || frame(seq) || frame(every persisted column) )` using
  pgcrypto's `digest(bytea,'sha256')`.

### The chain-head pointer (`audit_chain_head`) — O(1) tail discovery

To bind a new row, the trigger needs the **current tail** (the latest row's `row_hash`).
Discovering that by scanning the table — the original implementation used a `NOT EXISTS`
anti-join over the whole table — is **O(n) per insert / O(n²) over the table's life**, which
at gov audit volume (millions of rows over the ≥1095-day retention) degrades to *seconds per
insert* and chokes the fire-and-forget audit write path.

Instead the trigger keeps the tail in a tiny mutable state table:

```sql
CREATE TABLE audit_chain_head (table_name text PRIMARY KEY, head_hash bytea);
-- seeded: ('audit_logs', NULL), ('egress_decisions', NULL)
```

On each insert the trigger does `SELECT head_hash ... WHERE table_name = '<tbl>' FOR UPDATE`
(O(1)), uses it as `prev_hash`, computes `row_hash` **exactly as before** (same `frame()`
helper, same column order, same `coalesce(prev,'') || …` formula — only the *prev-discovery
mechanism* changed, never the hash formula), then `UPDATE audit_chain_head SET head_hash =
<new row_hash>`. The `FOR UPDATE` row lock is the real serializer: it both reads the current
head and blocks any concurrent insert on the same table from advancing it until commit, so two
concurrent inserts cannot bind the same head (no fork). A belt-and-suspenders per-table
advisory lock is also taken.

**`audit_chain_head` is NOT an audit table and is intentionally mutable** — the layer-1
append-only guards do *not* apply to it (the trigger must `UPDATE` it on every insert), and
`cosmos_app` holds `SELECT, UPDATE` on it (but it is excluded from the audit-table
`UPDATE/DELETE/TRUNCATE` revoke). **It is also NOT security-critical:** tampering with
`audit_chain_head` can only mis-link *future* rows (a wrong `prev_hash`), which
`verify_audit_chain` still detects as a **fork** / **row_hash mismatch** when it recomputes
from the audit rows. The audit **rows remain the sole source of truth**; the head table is
just a cache of "where the tail is."

`frame(t)` is a **length-prefixed bytea** encoding: `int4send(byte-length of UTF8(t)) ||
UTF8(t)`. The 4-byte length prefix makes the column concatenation injective (no value can be
mistaken for a different field boundary) **without any in-band separator** — so it is
all-bytes-safe and needs no NUL/`chr(0)` separator (a `chr(0)` separator is illegal in PG
`text`; this design avoids it entirely). `metadata` (which may be any JSON value — object,
array, string, number, `null`) is framed as `metadata::text`, never decomposed with
`jsonb_each` (which errors on non-object JSON).

Because each `row_hash` includes the previous `row_hash`, the rows form a **linked list**.
Any of these is then detectable:

| Tamper | How it's detected |
|---|---|
| Edit a historical row's content in place | its `row_hash` no longer recomputes → **content tampered** |
| Delete a mid-chain row | its successor's `prev_hash` now matches nobody → walk ends early → **unreachable rows** |
| Delete the head/genesis row | no `prev_hash IS NULL` row → **no genesis** |
| Insert/forge a branch row | two rows share a `prev_hash` → **fork** |
| Forge a second genesis | two `prev_hash IS NULL` rows → **multiple genesis** |

> **Concurrency note (why the chain is verified by LINKS, not by `seq`).** `seq` is a
> `GENERATED ALWAYS AS IDENTITY` counter allocated when the row tuple is formed — *before*
> the `BEFORE INSERT` trigger and *outside* the serializer. So under concurrent inserts the
> `seq` order can legitimately differ from the chain (serialization) order. The trigger
> therefore takes the tail from the `FOR UPDATE`-locked `audit_chain_head` row (which holds
> exactly one tail at a time), guaranteeing a single linear chain with no forks, and
> `verify_audit_chain` walks the `prev_hash → row_hash` links from genesis rather than
> ordering by `seq`. This was re-proven on a real PG16 cluster after the head-pointer change:
> 200+ concurrent inserts produced 0 forks, 1 genesis, 1 tail, all rows reachable.

> **Legacy rows / chain anchor (non-fresh DBs).** Per-tenant cutover applies migrations to a
> *fresh* DB, so the chain there runs from genesis. But an **existing** v2 instance upgrading
> 2.5.0 → 2.6.0 already has audit rows written *before* this migration — those legacy rows have
> both `row_hash IS NULL` and `prev_hash IS NULL`. `verify_audit_chain` scopes the chain to
> `row_hash IS NOT NULL`: legacy rows are **pre-chain and ignored** by verification (otherwise
> each would look like a separate genesis and falsely trip "multiple genesis rows"). The chain
> **anchors at the first row written after the migration** (the head pointer starts `NULL`
> regardless of legacy rows, so that first post-migration insert is a clean genesis). Legacy
> rows are *not* unprotected: they remain covered by the layer-1 append-only guards and the
> layer-3 offsite WORM anchor — they are simply outside the cryptographic linked list, which
> begins at 2.6.0.

**What it does NOT prove:** the hash-chain is *tamper-evidence*, not tamper-*proofing* — it
detects after the fact, it does not prevent (layer 1 prevents). And an attacker who can edit
the DB **and** recompute the entire chain forward from the edit would produce an internally
consistent chain; that residual is closed by layer 3 (the offsite WORM anchor they cannot
rewrite). The two layers are complementary.

---

## 2. How to verify (the operator action)

### Quick check (ops one-shot)

```sh
sudo docker compose --profile ops run --rm verify-audit-chain
```

- Connects as the least-privilege `cosmos_app` role (SELECT-only + EXECUTE on the verify
  function — never the owner).
- Prints one line per table; emits a machine-readable JSON summary to stdout.
- **Exit 0** = both chains intact. **Exit 2** = at least one chain is broken (alarm on this).
  **Exit 1** = a connection/SQL error (investigate the script/DB, not necessarily a tamper).

### Direct SQL (inside the DB)

```sql
-- Empty result set = intact. A returned row = the FIRST detected break.
SELECT * FROM verify_audit_chain('audit_logs');
SELECT * FROM verify_audit_chain('egress_decisions');
```

`verify_audit_chain(p_table regclass)` returns `(broken_seq bigint, reason text)`:
`broken_seq` is the `seq` of the offending row (or `NULL` for a structural break such as a
missing/duplicate genesis or unreachable rows), and `reason` names the failure class from the
table above.

### When to run it

- **Scheduled**, paired with `audit-worm-export` (e.g. before each WORM export, so the export
  anchors a chain you've just confirmed intact).
- **On demand** during an incident / forensic review.
- As a **CI / pre-export gate** — the non-zero exit blocks the pipeline on a detected break.

---

## 3. Relationship to the WORM anchor (defense in depth)

The in-DB chain and the offsite WORM export are two independent tamper-evidence layers:

- The **in-DB chain** gives you continuous, cheap, in-place detection — no external system,
  verifiable by a single SELECT, catches the common case (someone got owner and edited a row).
- The **WORM export** gives you an immutable offsite copy that survives even a full-DB rewrite;
  diffing the live tables against the last WORM manifest catches a re-chained forgery.

**Use them together.** Run `verify-audit-chain` immediately before `audit-worm-export` so each
WORM manifest anchors a chain that was intact at export time. A future enhancement (see the
handoff) is to record the chain head's `row_hash` (the tail) into each WORM export manifest,
cryptographically binding the two layers — then a verifier can confirm the live chain head
matches the last anchored head.

---

## 4. Retention-purge with chain-checkpoint (AU-11) — IMPLEMENTED

Gov **over-retains** (audit retention ≥ 1095 days; often longer). When the retention floor is
reached, the **sanctioned** way to remove the oldest rows is the owner-only purge job
`scripts/dsop/purge-audit.mjs` (compose one-shot `purge-audit`). It deletes the chain **head**
(the oldest rows) WITHOUT breaking `verify_audit_chain`, because it records a **signed
chain-checkpoint** at the purge boundary first. Migration
`20260606130000_audit_retention_checkpoint` adds the `audit_chain_checkpoint` table and makes
`verify_audit_chain` checkpoint-aware.

### How it stays tamper-evident across the boundary

The purge, in **one owner transaction**:

1. Computes `N = max(seq)` among rows with `created_at < now() - retentionDays`.
2. Records a checkpoint row `(table_name, checkpoint_seq = N, checkpoint_row_hash = <row_hash
   at seq N>, sig)` where `sig = HMAC_sha256(key, table_name || N || hex(row_hash@N))` (the
   key is `WORM_MANIFEST_HMAC_KEY` by default, or `--hmac-key-env <NAME>`).
3. `SET LOCAL session_replication_role = replica` (the **only** way to bypass the layer-1
   append-only trigger — for this transaction only) and `DELETE FROM <table> WHERE seq <= N`.

The deleted row at seq N is gone, but the **first retained row's `prev_hash` still equals the
checkpoint's `checkpoint_row_hash`** (that link lives on the *retained* successor row, which is
not deleted). So `verify_audit_chain` re-anchors there: with a checkpoint present it walks from
the unique retained row whose `prev_hash = checkpoint_row_hash` instead of from a
`prev_hash IS NULL` genesis, recomputing every hash through the tail (scoped to
`seq > checkpoint_seq`). The purged prefix is vouched for by the WORM export that captured it
before deletion, plus the signed checkpoint.

### Two-layer checkpoint verification (structural in SQL, sig in JS)

A SQL function **cannot read the HMAC key from env**, so the split is deliberate:

- **`verify_audit_chain` (SQL) anchors STRUCTURALLY** at `checkpoint_row_hash`. It detects a
  missing/altered anchor (`no row anchors at checkpoint`), a boundary fork, content tamper,
  mid-chain deletes, etc. — but it does **not** check the checkpoint's signature.
- **`scripts/dsop/verify-audit-chain.mjs` (the wrapper) checks the HMAC sig** of the latest
  checkpoint per table by recomputing `HMAC(key, table || seq || hex(row_hash))` and comparing
  (constant-time). A **forged checkpoint** — inserted by an attacker who reached owner and
  disabled the guards, to re-anchor a tampered chain — has a sig that does not recompute, so
  the wrapper exits **2** (`checkpoint sig INVALID (forged/altered checkpoint)`). It also fails
  closed (exit 2) if a checkpoint exists but no key is supplied to verify it.

So a forged checkpoint can pass the structural SQL check yet is still caught by the wrapper's
sig check — empirically proven on PG16 (see the proof matrix referenced below).

### Hard guards (the purge refuses rather than risk integrity)

1. **WORM-export-FIRST ordering.** The script refuses if `N > the latest WORM-attested toSeq`
   for the table (read from the `cosmos-audit-worm` bucket's signed `manifest-toSeq-<N>.json`
   keys, or `--worm-toseq`). **Never delete a row that wasn't anchored offsite first.** So the
   operational order is always: **WORM export → purge → verify.**
2. **Gov retention floor (≥ 1095 days).** The script refuses `--retention-days < 1095` UNLESS
   the explicit, loud, **TEST-ONLY** env `AUDIT_PURGE_ALLOW_BELOW_FLOOR_DAYS=<min-days>` is
   set (used only by the Docker acceptance / tests — never in production).
3. **Owner-only.** The script refuses if `DATABASE_URL` points at `cosmos_app` (which cannot
   `DELETE` and cannot even `SET session_replication_role` — proven). The purge MUST run as
   the owner (`cosmos`).
4. **Idempotent.** Re-running is a clean no-op (a checkpoint already covering `N`, or nothing
   below the cutoff).

### Operator procedure

```sh
# 1. Anchor the rows being purged offsite FIRST (advances the WORM high-water mark).
sudo docker compose --profile ops run --rm audit-worm-export

# 2. Verify the chain is intact BEFORE purging (never purge over an already-broken chain).
sudo docker compose --profile ops run --rm verify-audit-chain

# 3. Purge (owner; default table audit_logs, default retention 1095d = the gov floor).
sudo docker compose --profile ops run --rm \
  -e PURGE_TABLE=audit_logs -e PURGE_RETENTION_DAYS=1095 purge-audit
sudo docker compose --profile ops run --rm \
  -e PURGE_TABLE=egress_decisions -e PURGE_RETENTION_DAYS=1095 purge-audit

# 4. Verify AFTER the purge — INTACT means it re-anchored at the checkpoint with a valid sig.
sudo docker compose --profile ops run --rm verify-audit-chain
```

**`cosmos_app` still cannot delete audit rows** after this change — the layer-1 REVOKE +
append-only trigger are untouched; only the owner, in explicit replica mode, can. The
checkpoint table is itself append-only for the app (`cosmos_app` has `SELECT` only; INSERT/
UPDATE/DELETE/TRUNCATE are REVOKEd) so the app cannot forge or alter a checkpoint.

> **Out of scope / noted:** an automated purge scheduler/cron is ops (the script + this
> runbook are the engineering deliverable); per-org retention overrides; purging other large
> tables. Multi-statement insert ordering within one transaction and logical-replication
> replay are not specially handled; the chain is correct for the single-row fire-and-forget
> INSERT path the app uses (see `src/lib/audit.ts` and `src/lib/ai/egress/audit.ts`).

---

## 5. If a break is reported

1. **Do not panic-mutate.** Capture the full `verify-audit-chain` JSON output and the
   `broken_seq` / `reason`.
2. **Diff against the last WORM export** for the affected table to determine whether the live
   DB or (less likely) the export is the divergent copy, and to recover the authentic rows.
3. **Treat as a security incident** (IR): a break means either a bug in a future migration
   touching these tables, or an actor who reached owner/superuser and disabled the guards —
   both warrant investigation. Preserve the DB state for forensics.
4. The append-only guards remain in force; normal INSERT traffic is unaffected.
