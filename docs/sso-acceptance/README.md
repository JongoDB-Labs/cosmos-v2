# SSO OIDC round-trip — Docker acceptance

A throwaway `dexidp/dex` (OSS OIDC IdP) drives a real authorize → login →
callback against the running cosmos stack to prove the in-app OIDC RP end-to-end.

## What's committed vs. gitignored

Committed (no secrets):
- `seed.ts` — seeds a test `Organization` (slug `dextest`, GOV) + an
  `IdpConnection` (issuer = dex, client id, **vault-sealed** client secret).
- `drive.mjs` — the in-network OIDC driver (login → dex → callback) + assertions.
- `README.md` (this file).

Gitignored (carry throwaway secrets — never commit):
- `docker-compose.dex.yml` — the dex compose override (client secret, insecure flag).
- `dex.config.local.yaml` — dex config (static client secret + test-user bcrypt hash).
- `.env` — local stack env incl. the throwaway `SSO_VAULT_KEY`.
- `evidence/` — captured run output.

## Run it

```bash
# 0. throwaway vault key
openssl rand -base64 32          # → SSO_VAULT_KEY in .env

# 1. build (host network so the MiniLM model bake can reach HF)
sudo docker build --network=host --target migrate -t cosmos-v2-migrate:dev .
sudo docker build --network=host -t cosmos-v2:dev .

# 2. up (cosmos + postgres + caddy + dex)
sudo docker compose -f docker-compose.yml -f docker-compose.dex.yml up -d

# 3. seed the test org + IdpConnection (mount seed.ts into the migrate image)
sudo docker compose -f docker-compose.yml -f docker-compose.dex.yml run --rm \
  --entrypoint sh \
  -v "$PWD/docs/sso-acceptance/seed.ts:/app/docs/sso-acceptance/seed.ts:ro" \
  cosmos-migrate -c "node_modules/.bin/tsx docs/sso-acceptance/seed.ts"

# 4. drive the round-trip in-network (cosmos + dex resolvable by service name)
sudo docker run --rm --network cosmos-v2_default \
  -v "$PWD/docs/sso-acceptance/drive.mjs:/drive.mjs:ro" \
  -e COSMOS_BASE=http://cosmos:3000 -e FWD_HOST=localhost:8090 \
  --entrypoint node cosmos-v2:dev /drive.mjs

# 5. assert DB rows
PSQL="sudo docker compose -f docker-compose.yml -f docker-compose.dex.yml exec -T cosmos-postgres psql -U cosmos -d cosmos -tAc"
$PSQL "SELECT subject FROM federated_identities;"
$PSQL "SELECT auth_method, mfa_satisfied FROM sessions;"
$PSQL "SELECT action FROM audit_logs WHERE action='auth.sso.login';"

# 6. tear down
sudo docker compose -f docker-compose.yml -f docker-compose.dex.yml down -v
```

## Networking notes (why in-network + forwarded headers)

The driver hits cosmos directly at `http://cosmos:3000` and sets
`X-Forwarded-Host: localhost:8090` + `X-Forwarded-Proto: http` itself, so
`getPublicOrigin()` computes a stable public origin (`http://localhost:8090`)
that matches dex's registered `redirectURI`. dex's issuer is `http://dex:5556/dex`
(resolvable in-network by both cosmos and the driver). dex over http requires
`SSO_ALLOW_INSECURE_ISSUER=1` on the cosmos service (set in the dex override;
default-off everywhere else).

## Observed result (2026-06-06)

Real round-trip succeeded: callback `307 → http://localhost:8090/` with a
`session` cookie set; `federated_identities` row matched by dex `sub`; `sessions`
row with `auth_method=oidc`; `org_members` MEMBER row JIT-provisioned;
`audit_logs` `auth.sso.login` row written. Migration `20260606060000_add_sso_oidc_rp`
applied; `/api/health` 200. See `evidence/` (gitignored) for raw output.
