# Runbook: Secret Rotation (IA-5 / key management, NIST 800-171 SC 3.13.10)

How to rotate every long-lived secret in COSMOS v2 **without downtime or data loss**,
with a rollback for each. The hard case — the **vault master key** — is solved with a
keyring (multiple keys, one active) + a re-wrap pass so secrets migrate to the new key
*before* the old one is retired. Everything else is an env-injected secret that rotates by
swap + (where the backing service supports it) an overlap window + a rolling restart.

> **Gov note.** In production every secret here is injected as a **Docker / orchestrator
> secret**, never a plaintext env var. "Set env → rolling restart" below means "update the
> secret store → roll the pods". Record each rotation (who, when, why, kid/version) in the
> change log; secret rotation is an auditable IA-5 event.

> **Golden rule of overlap.** Never remove the old credential until the new one is proven
> in use across **all** replicas. For the vault key that proof is `rotate-vault-key.mjs
> --check` returning 0. For service creds it's a successful health check on every replica
> after the restart.

---

## 1. Vault master key (`SSO_VAULT_KEY` → keyring) — the re-wrap case

**What it protects:** per-tenant OIDC client secrets sealed at rest with AES-256-GCM
(`IdpConnection.client_secret_enc`), opened at use in `src/lib/auth/sso.ts`. The vault is
the reusable sealing primitive (connector creds will reuse it next).

**Why it needs a keyring:** a single key can't be rotated in place — you'd have to
re-encrypt every sealed secret first, and during that window some secrets are under the old
key and some under the new. The vault (`src/lib/crypto/vault.ts`) holds a **ring** of keys
addressed by `kid`; new secrets seal under the **active** kid; old secrets keep opening
under their original kid until re-wrapped. Envelope: `v2.<kid>.<iv>.<tag>.<ct>` (legacy
single-key `v1.<iv>.<tag>.<ct>` blobs still open, under ring kid `v1`).

### Rotate-then-retire procedure (zero downtime)

Assume the current key is kid `v1` (legacy single-key deployments are exactly this: ring
`{v1}`, active `v1`). We rotate to a new kid `v2k`.

1. **Generate the new key.**
   ```bash
   openssl rand -base64 32        # → the new 32-byte key for kid "v2k"
   ```

2. **Add it to the ring alongside the old key, keep the OLD key active for now.** Set both
   env vars on the `cosmos` app service (replace the single `SSO_VAULT_KEY`):
   ```bash
   SSO_VAULT_KEYS='{"v1":"<OLD_KEY_BASE64>","v2k":"<NEW_KEY_BASE64>"}'
   SSO_VAULT_ACTIVE_KID=v1        # still sealing under the OLD key
   ```
   > In legacy single-key mode the old key was `SSO_VAULT_KEY`; copy that value in as kid
   > `v1`. Once `SSO_VAULT_KEYS` is set, `SSO_VAULT_KEY` is ignored — keep it set to the
   > same value during the transition for a clean rollback, then remove it at the end.

3. **Rolling restart.** Every replica now has BOTH keys in the ring (it can open old- and
   new-sealed secrets) but still seals new secrets under the old kid. SSO is unaffected.

4. **Flip the active kid to the new key** and rolling-restart again:
   ```bash
   SSO_VAULT_ACTIVE_KID=v2k       # new secrets now seal under the new key
   ```
   New seals (e.g. a freshly configured IdP) are under `v2k`; existing rows are still `v1`.

5. **Re-wrap all existing sealed secrets to the active kid.** Run the one-shot (it connects
   as the least-privilege `cosmos_app` role, opens each secret under its current kid, and
   re-seals under the active kid; idempotent — only changed rows are written):
   ```bash
   sudo docker compose --profile ops run --rm rotate-vault-key
   ```

6. **Confirm rotation is complete** (report-only, exits non-zero if anything is left on a
   non-active kid — use this as the gate before retiring the old key):
   ```bash
   sudo docker compose --profile ops run --rm rotate-vault-key --check
   # → {"...","onNonActiveKid":0}  (exit 0). Non-zero ⇒ do NOT retire yet.
   ```
   A second `run --rm rotate-vault-key` is a no-op (`rewrapped 0`) — proof of idempotency.

7. **Retire the old key.** Once `--check` reports 0, drop the old kid from the ring and
   roll once more:
   ```bash
   SSO_VAULT_KEYS='{"v2k":"<NEW_KEY_BASE64>"}'
   SSO_VAULT_ACTIVE_KID=v2k
   # remove the now-unused legacy SSO_VAULT_KEY entirely
   ```
   After this restart, any value still sealed under `v1` would **fail to open** ("Vault key
   v1 is not in the keyring — it may have been retired") — which is the IA-5 evidence that
   the old key is truly gone. Because step 5 migrated every secret, SSO keeps working.

8. **Destroy the old key material** from the secret store / operator hands.

**The overlap window** is steps 2–6: the old key stays in the ring the whole time so no
secret is ever unreadable. Retirement (step 7) only happens after `--check` proves 0
secrets remain on it.

### Rollback

- **Before step 7 (old key still in ring):** revert `SSO_VAULT_ACTIVE_KID` to `v1` and roll
  back. Already-re-wrapped rows are `v2k` and still open (the new key is in the ring); new
  seals revert to `v1`. No data loss. You can re-run the re-wrap later.
- **After step 7 (old key removed) and a problem appears:** put the old key back into
  `SSO_VAULT_KEYS` and roll. Nothing was destroyed by the re-wrap (it only re-encrypted in
  place), so adding the old kid back restores the ability to open any straggler. Do not
  delete old key material until you have observed a full stable cycle.

### Compromise (emergency)

If a key is *compromised* (not merely aged out), you cannot trust anything sealed under it.
After re-wrapping to a fresh key, also **rotate the underlying secrets themselves** — i.e.
rotate each affected IdP's client secret at the IdP and re-seal — because the plaintext may
have been exposed while the key was compromised. Key rotation protects future seals; it
does not un-leak a plaintext that was already decrypted with the bad key.

---

## 2. `ANTHROPIC_API_KEY` — stateless swap

**What it is:** the credential for the sole external-model egress chokepoint
(`src/lib/ai/egress`). Stateless per-call (no server-side session bound to the key), so no
overlap window is needed.

1. Issue a **new** API key in the Anthropic console.
2. Set `ANTHROPIC_API_KEY=<new>` on the `cosmos` service (secret store in prod).
3. Rolling restart. The chokepoint is the only caller, so one env var is the entire surface.
4. Verify a model-bound turn succeeds on every replica.
5. **Revoke the old key** in the Anthropic console.

**Rollback:** if the new key fails, restore the old `ANTHROPIC_API_KEY` and roll back
(don't revoke the old key until the new one is verified in prod).

---

## 3. pgBackRest repo cipher (`PGBACKREST_REPO1_CIPHER_PASS`) — new-stanza procedure

**What it protects:** AES-256-CBC encryption of the backup repo (`cosmos-pgbackrest`). You
**cannot re-encrypt an existing repo's backups in place** — pgBackRest seals each backup
set under the pass that was active when it was written.

**Procedure (overlap by retention, not in-place):**
1. Provision a **new stanza/repo** (or a new repo prefix) configured with the new
   `PGBACKREST_REPO1_CIPHER_PASS`.
2. `pgbackrest stanza-create` for the new stanza, then take a **fresh full backup** so the
   new repo is immediately restorable on its own.
3. Re-point WAL archiving + scheduled backups at the new stanza.
4. **Retain the OLD repo read-only** until its retention window passes (the old cipher pass
   is still required to restore from it — keep both passes recorded until then).
5. Once no recovery target predates the new full backup, retire the old repo and its pass.

**RPO implication:** there is a brief gap between the last old-repo backup and the first
new-repo full backup. Schedule the cutover right after a successful full and confirm
continuous WAL archiving to the new stanza before retiring the old, so PITR coverage stays
continuous. Run `scripts/dsop/restore-drill.sh` against the new repo before retiring the old.

**Rollback:** keep the old stanza + old cipher pass until the new repo has a verified
restore drill; if the new repo fails verification, re-point archiving back at the old stanza.

---

## 4. MinIO access keys (`S3_*`, `WORM_*`) — svcacct overlap

**What they are:** the least-privilege app key (`cosmos-app`: RW on `cosmos-uploads` +
`cosmos-pgbackrest`) and the append-only WORM key (`cosmos-worm`: write+read on the
object-locked `cosmos-audit-worm`). MinIO supports multiple service-account keys per user,
so rotation has a clean overlap.

1. Create a **new** service-account key with the same policy:
   ```bash
   mc admin user svcacct add <alias> <parent-user>   # → new access/secret key pair
   ```
2. Update the env (`S3_ACCESS_KEY`/`S3_SECRET_KEY`, or `WORM_ACCESS_KEY`/`WORM_SECRET_KEY`)
   on the consuming services (`cosmos`, `audit-worm-export`, `cosmos-postgres`/`cosmos-backup`
   for the pgBackRest repo keys).
3. Rolling restart; verify uploads / a WORM export / a backup succeed on the new key.
4. **Remove the old service account:**
   ```bash
   mc admin user svcacct rm <alias> <OLD_ACCESS_KEY>
   ```

**Rollback:** the old svcacct stays valid until step 4, so revert the env and roll back any
time before then. For the WORM key specifically, never grant the new key
delete/retention-bypass verbs — keep it append-only (write + read only), same as the old.

---

## 5. WORM manifest HMAC key (`WORM_MANIFEST_HMAC_KEY`) — keep old keys forever

**What it protects:** the HMAC signature on each offsite audit-export manifest
(`scripts/audit-worm-export.mjs`). Rotation changes **future** manifest signatures only —
historical manifests in the object-locked bucket were signed under the **old** key and must
stay verifiable.

1. Set `WORM_MANIFEST_HMAC_KEY=<new>` on the `audit-worm-export` job; future manifests sign
   under it.
2. **Record the key-version → manifest mapping** (e.g. "manifests after seq N use HMAC v2").
   A verifier must pick the right key for a given manifest's era.
3. **Do NOT destroy old HMAC keys.** They are needed to verify any historical WORM export.
   Retain every HMAC key for the full audit-retention period (gov floor: 3 years; WORM
   object-lock here is 3650 days).

**Rollback:** revert `WORM_MANIFEST_HMAC_KEY`; no historical data is affected because old
manifests are verified with their own (retained) key regardless of the current one.

> **Future hardening:** stamp a `hmacKeyId` into the manifest core so the key era is
> self-describing rather than operator-tracked. (Deferred — not yet implemented.)

---

## 6. Database passwords (`COSMOS_APP_PASSWORD`, owner `cosmos`)

**What they are:** the login passwords for the least-privilege app role (`cosmos_app`, used
by the running app via `DATABASE_URL`/`DIRECT_URL`) and the owner role (`cosmos`, used by
`cosmos-migrate`). Postgres applies a password change immediately, so the overlap is just
the rolling restart.

1. Rotate the role password in Postgres:
   ```sql
   ALTER ROLE cosmos_app PASSWORD '<new>';   -- or: ALTER ROLE cosmos PASSWORD '<new>';
   ```
2. Update the connection strings everywhere the role is used:
   - `cosmos_app`: `COSMOS_APP_PASSWORD` (compose composes `DATABASE_URL`/`DIRECT_URL` from
     it for the `cosmos` app **and** the `audit-worm-export` + `rotate-vault-key` one-shots).
   - owner `cosmos`: `DATABASE_URL`/`DIRECT_URL` for `cosmos-migrate` (and any direct admin).
3. Rolling restart the consumers; verify DB connectivity (`/api/health`) on every replica.

**Rollback:** `ALTER ROLE ... PASSWORD '<old>'` and revert the env. Brief connection
errors are possible if a replica restarts before the `ALTER ROLE` propagates — sequence the
`ALTER ROLE` first, then roll.

> **Order matters:** change the password in Postgres **first**, then roll the app. A replica
> still holding an open pooled connection keeps working until it reconnects, so do the roll
> promptly after the `ALTER ROLE` to avoid a window where new connections use a stale password.

---

## 6a. Legacy plaintext Google-token drain — **drain-before-drop ordering** (one-time)

**What it is:** the v2.12.0 cleanup that removed the last plaintext secret column,
`users.google_refresh_token`. The sealed `connector_credentials` store has been the source
of truth since v2.7.0; this drains any remaining plaintext token into it and drops the column.

The read-path plaintext **fallback was removed** in the same change (`getGoogleClientForUser`
now reads ONLY the sealed store), so once the column is dropped an **un-swept token is lost**.
Therefore on any **non-empty** instance, run the drain BEFORE the drop migration:

```bash
# 1. Seal every remaining plaintext token into connector_credentials + NULL the column.
#    Idempotent; exits NON-ZERO if any token can't be swept (user has no org membership yet) —
#    gate on a clean (exit 0) run before dropping.
node_modules/.bin/tsx scripts/dsop/seal-google-tokens.mjs

# 2. Only after a clean drain, apply the drop-column migration.
npx prisma migrate deploy   # applies 20260606120000_drop_google_refresh_token (as owner)
```

A user with a token but **no org membership yet** is left in place and reported (it would
re-issue + seal on the next OAuth grant once they have an org) — do NOT drop the column while
any such token remains. On a **greenfield** instance there are no rows: the drain is a no-op
and the ordering is moot (the migration is safe either way).

**Rollback:** the drop is one-way (the column is gone). Restore from backup if a token was
lost by dropping before draining. Going forward there is nothing to rotate here — the Google
refresh token lives only in `connector_credentials.secret_enc`, rotated by section 1.

---

## 7. Forward / not yet implemented

These rotate-points don't exist in the codebase yet; documented so they aren't forgotten when
the relevant layer ships:

- **Connector OAuth credentials** (the Nango-backed connector layer). They will reuse the
  **same vault keyring**, so the *key* rotation is already covered — when the connector
  credential table lands, add its `{table, pk, column}` to `SEALED_COLUMNS` in
  `scripts/dsop/rotate-vault-key.mjs` (a TODO marker is in place) and a single re-wrap pass
  migrates them too. Rotating the *connector creds themselves* (re-consent / new client
  secret at each provider) is a separate, provider-specific procedure to author then.
- **Provider-side revoke of migrated Google tokens** (the per-tenant cutover from v1).
  When cutover ships, add the step to revoke the old Google refresh/access tokens at the
  provider after the connector layer has re-issued its own — to be authored with that phase.

---

## Acceptance evidence

The rotate-then-retire cycle for the vault key (section 1) is proven end-to-end against the
dex SSO acceptance harness — SSO works before rotation, after the re-wrap, and after the old
key is removed from the ring, and an old-sealed value fails to open once the key is retired.
See `docs/sso-acceptance/` + the secret-rotation acceptance output captured at release time.
```text
SEALED_COLUMNS today: idp_connections.client_secret_enc, connector_credentials.secret_enc,
webhooks.secret, mcp_servers.env_enc, mcp_servers.headers_enc — all vault-sealed, re-wrapped
in one pass. (webhooks.secret may hold a legacy plaintext value on a pre-sealing row; the
re-wrap SKIPS those — they self-heal to sealed on next dispatch.)
Rotation completeness gate:  rotate-vault-key.mjs --check  (exit non-zero if any secret
is still on a non-active kid).
No plaintext secret columns remain (users.google_refresh_token dropped in v2.12.0).
```
