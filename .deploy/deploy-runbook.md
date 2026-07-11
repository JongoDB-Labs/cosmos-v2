# COSMOS coordinated prod deploy — runbook (3.39.0 → 4.5.0)

**Why this is delicate:** ONE shared Postgres (`127.0.0.1:5432/cosmos`) backs prod + dev + every worktree. The live `:3000` (`cosmos-app.service`, runs from `/home/defcon/cosmos-prod`) currently serves **3.39.0** against **Float money columns** (`money_float_to_decimal` is NOT applied). Deploying main (4.5.0) applies the **non-backward-compatible Float→Decimal** migration (+ ledger + bank). The instant that migration runs, the old 3.39.0 server is broken until it's rebuilt+restarted to 4.5.0 — so migrate→restart must be a tight back-to-back window. There is also an **auto-deploy webhook** (`cosmos-deploy.service`) that must be paused so it can't race.

**Environment facts (verified 2026-06-05):**
- Deploy target dir: `/home/defcon/cosmos-prod` (detached HEAD @ 3.39.0; has its own `.next`).
- Live service: `cosmos-app.service` → `npx next start -H 127.0.0.1 -p 3000`, WorkingDirectory `/home/defcon/cosmos-prod`.
- Auto-deployer: `cosmos-deploy.service` (`/opt/cosmos-deploy/server.js`) — PAUSE during the window.
- Multiple stray `next start` procs were running (in `/home/defcon/cosmos-prod` AND `/home/defcon/cosmos-saas`) — identify the systemd one (`systemctl show -p MainPID cosmos-app.service`) and kill strays.
- DB creds: prod `DATABASE_URL`/`DIRECT_URL` live in `.env.local`; **prisma CLI only auto-loads `.env`**, so prefix prisma with `set -a; . ./.env.local; set +a`.
- This is `sudo -n` (passwordless) territory for the service commands (per the established procedure).

---

## 0. Pre-flight (before the window)
1. Confirm main is green & at the intended version:
   `gh pr checks` clean on what landed; `git -C /home/defcon/cosmos-saas show origin/main:package.json | grep version` → **4.5.0**.
2. **Quiesce the other sessions** — paste `.deploy/STAND-DOWN.md` into each (assistant, notes, meetings, finance, chat). Wait for them to confirm idle.
3. **Arm the freeze:** `touch /home/defcon/cosmos-saas/.deploy-lock` (the guard hook now blocks migrate/build/restart in guarded sessions).
4. **Pause the auto-deployer:** `sudo -n systemctl stop cosmos-deploy.service`.
5. **Kill stray `next start`** (keep only the systemd one): `MP=$(systemctl show -p MainPID --value cosmos-app.service); for p in $(pgrep -f "next start"); do [ "$p" = "$MP" ] || kill "$p"; done` (re-check with `pgrep -af "next start"`).
6. **Baseline + dump:** `cd /home/defcon/cosmos-saas && bash .deploy/snapshot-baseline.sh` → record the money SUMs JSON + confirm a `.deploy/backups/cosmos-*.sql.gz` exists. **Do not proceed without the dump.**

## 1. Stage the new code in the prod checkout (old server still up)
```
cd /home/defcon/cosmos-prod
git fetch origin
git checkout origin/main          # detached at 4.5.0
node -p "require('./package.json').version"   # expect 4.5.0
npm ci                            # 3.39.0→4.5.0 added deps (ofx-data-extractor, etc.)
set -a; . ./.env.local; set +a
npx prisma generate
```

## 2. Confirm the migration set (dry, read-only)
```
npx prisma migrate status         # env still sourced
```
Pending should be EXACTLY these **6** (verified read-only 2026-06-05 via `migrate status` against the shared DB) — the finance set **plus three additive chat migrations that 3.39.0 predates**:
- `20260603130000_money_float_to_decimal`  ← **BREAKING** (Float→Decimal)
- `20260604000000_add_ledger_engine`        ← additive
- `20260604010000_chat_bots`                ← additive
- `20260604020000_add_bank_feeds`           ← additive
- `20260604020000_chat_threads`             ← additive
- `20260604030000_chat_alerts_presence`     ← additive

All 6 are required by 4.5.0; the five non-money ones are pure CREATE/ADD/INSERT (no DROP / ALTER-TYPE / TRUNCATE — verified). The classification + meeting migrations are already applied. **If anything OTHER than these 6 is pending, or it reports a *failed*/modified migration or wants a reset → ABORT** and investigate.

> Benign known item: the long-applied `20260528160000_rename_chat_to_assistant` has a stored-checksum difference from the merged line (the pre-fork copy differed by whitespace). `migrate status` does **not** flag it and `migrate deploy` does **not** re-run applied migrations, so it is **not** a blocker. Do not "fix" it.

## 3. Build (old server survives its content-hashed chunks)
```
npm run build                     # in /home/defcon/cosmos-prod; produces the 4.5.0 .next
```

## 4. THE TIGHT WINDOW — migrate then restart back-to-back
```
npx prisma migrate deploy         # BREAKING: Float→Decimal now live; old server is incompatible from here
sudo -n systemctl restart cosmos-app.service
```
Wait ~20s (old next-server can take ~15s to SIGKILL before the new one binds).

## 5. Verify
```
curl -s http://127.0.0.1:3000/api/health          # expect {"ok":true,"db":"up","version":"4.5.0"}
npx prisma migrate status                          # "Database schema is up to date!"
cd /home/defcon/cosmos-saas && bash .deploy/snapshot-baseline.sh   # money SUMs MUST equal the pre-deploy SUMs
```
Smoke test in a browser/curl: a finance/accounting page (Decimal money renders), a project **classification banner**, and the project **Documents** tab (upload/list).

## 6. Resume
1. **Lift the freeze:** `rm /home/defcon/cosmos-saas/.deploy-lock`.
2. **Re-enable auto-deploy:** `sudo -n systemctl start cosmos-deploy.service` (verify it doesn't immediately try to re-deploy something stale).
3. Tell the other sessions to resume and `git pull` / re-fetch (main advanced + the DB migrated).

---

## Rollback (if health fails, version wrong, or money SUMs differ)
1. **Restore the DB** from the dump (the Float→Decimal migration has no auto-down):
   `set -a; . ./.env.local; set +a; gunzip -c /home/defcon/cosmos-saas/.deploy/backups/cosmos-<ts>.sql.gz | psql "$DATABASE_URL"`
   (Restoring into the live DB may require dropping/recreating the `public` schema first — do this deliberately; it's why the dump exists.)
2. **Revert the code:** `cd /home/defcon/cosmos-prod && git checkout 3b82ded` (3.39.0) `&& npm ci && npm run build`.
3. `sudo -n systemctl restart cosmos-app.service`; verify `/api/health` shows 3.39.0, db up.
4. Lift freeze + re-enable auto-deploy + tell sessions to resume.

## Notes
- **Order rationale:** migrate-before-code is only safe for *additive* migrations; this one is breaking, so build first, then migrate+restart back-to-back to minimize the broken window. (A true zero-downtime path would be expand-contract — out of scope here.)
- The duplicate timestamp `20260603120000` (`add_meeting_video_fields` vs `add_project_classification_relation`) is a non-issue: both are already recorded in the shared `_prisma_migrations` (Prisma matches by name).
- Keep all output redacted of `postgres://…:password@…`.

---

## Foreman watchdog (daemon-down alerting)

Detect silent foreman daemon (no heartbeat for 10+ minutes) and fire alerts to the app. Installed once, runs independently on the host.

### Installation

1. **Create the env file** (root-owned, 0600):
   ```bash
   sudo tee /etc/foreman-watchdog.env > /dev/null <<'EOF'
   DATABASE_URL="postgresql://cosmos:password@127.0.0.1:5432/cosmos"
   FOREMAN_ALERT_TOKEN="<generate: openssl rand -hex 32>"
   ALERT_URL="http://127.0.0.1:8090/api/foreman/alert"
   EOF
   sudo chmod 0600 /etc/foreman-watchdog.env
   ```
   Replace `password` with the actual DB password, and generate a random token with `openssl rand -hex 32`.

2. **Copy systemd units** to the system:
   ```bash
   sudo cp /home/defcon/cosmos-v2/.deploy/foreman-watchdog.{service,timer} /etc/systemd/system/
   sudo cp /home/defcon/cosmos-v2/.deploy/foreman-alert.service /etc/systemd/system/
   ```

3. **Reload systemd and enable the timer**:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now foreman-watchdog.timer
   ```

4. **Wire up unit failure alerts** (edit the foreman.service drop-in):
   ```bash
   sudo systemctl edit foreman
   ```
   Add under `[Unit]`:
   ```ini
   OnFailure=foreman-alert.service
   ```

5. **Configure the app** to accept alerts (same token):
   - Add `FOREMAN_ALERT_TOKEN=<the-same-32-char-hex-token>` to the app container env (e.g., `docker-compose.override.yml` or cloud secrets).
   - The app endpoint `/api/foreman/alert` (bearer auth) dedupes alerts 6h server-side and writes alert rows.

### Verification

- Check timer status: `sudo systemctl status foreman-watchdog.timer`
- Manual test (requires stale DB state):
  ```bash
  DATABASE_URL="postgresql://cosmos:…@host/cosmos" FOREMAN_ALERT_TOKEN=test ALERT_URL=http://127.0.0.1:8090/api/foreman/alert bash /home/defcon/cosmos-v2/.deploy/foreman-watchdog.sh
  echo "exit=$?"
  ```
  Must exit 0. Check `/var/tmp/foreman-watchdog.state` for the internal state file (should contain `0` or `1`).
