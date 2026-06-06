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
  **genesis** row (the first row ever inserted in the table).
- `row_hash` — `sha256( prev_hash || frame(seq) || frame(every persisted column) )` using
  pgcrypto's `digest(bytea,'sha256')`.

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
> the `BEFORE INSERT` trigger and *outside* the per-table advisory lock the trigger takes to
> serialize chain extension. So under concurrent inserts the `seq` order can legitimately
> differ from the chain (lock-acquisition) order. The trigger therefore selects the chain
> head as the actual **tail** (the row no one has chained onto yet) under the advisory lock,
> guaranteeing a single linear chain with no forks, and `verify_audit_chain` walks the
> `prev_hash → row_hash` links from genesis rather than ordering by `seq`. This was proven on
> a real PG16 cluster: 200 concurrent inserts produced 0 forks, 1 genesis, 1 tail, all rows
> reachable.

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

## 4. Retention-purge constraint (DEFERRED — read before building purge)

Gov **over-retains** (audit retention ≥ 1095 days; often longer), so there is currently **no
purge** and the chain runs unbroken from genesis. When a retention-purge job is eventually
built, it will truncate the **head** of the chain (the oldest rows) — which would make a
naive genesis-to-now `verify_audit_chain` fail (no `prev_hash IS NULL` genesis row, or
unreachable older rows). The purge job MUST therefore:

1. **Verify intact up to the purge boundary first** — never purge over an already-broken chain.
2. **Record a signed checkpoint** at the new boundary: the `seq` and `row_hash` of the
   oldest *retained* row (the new genesis-after-purge), signed the same way the WORM manifest
   is (HMAC), and ideally co-located with the WORM anchor.
3. **Re-anchor verification** to "verify FROM the last WORM-anchored / checkpointed `seq`
   forward" — i.e. `verify_audit_chain` (or a `from_seq` variant of it) treats the
   checkpointed row as the trusted genesis, and the purged prefix is vouched for by the WORM
   export that captured it before deletion.
4. Run as the **owner** with the append-only guard explicitly disabled for the purge window
   only (the only legitimate deletion path), inside a single transaction, logged as an AU
   event.

Until that exists, **do not delete audit rows by any means** — the guards will block it and
that is the intended behavior.

> **Out of scope / noted:** multi-statement insert ordering within one transaction and
> logical-replication replay are not specially handled; the chain is correct for the
> single-row fire-and-forget INSERT path the app uses (see `src/lib/audit.ts` and
> `src/lib/ai/egress/audit.ts`).

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
