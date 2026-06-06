# COSMOS v2 — SSO Phase 1 (in-app OIDC RP) — Handoff

Branch `feat/sso-oidc-rp`. Plan: `docs/superpowers/plans/2026-06-06-cosmos-v2-sso-oidc-rp.md`.

This slice ships the **in-app OIDC Relying Party** and wires it into the existing
DB-backed session system. cosmos remains the single session + OrgMember + audit
authority; the IdP only asserts identity. SAML 2.0 / PIV-CAC / FIPS crypto are
deferred to an optional in-boundary **Keycloak** translation-appliance
(SAML/CAC→OIDC); in-app WebAuthn step-up and inbound SCIM are also follow-ons.

---

## Break-glass — the gov SSO lockout risk (READ THIS)

When a GOV org enables `enforced` SSO, the Google login path is **rejected** for
its members (see `src/lib/auth/sso-enforcement.ts` → `googleLoginBlockedByGovSso`).
This is intentional: gov members must authenticate through the IdP so the
IdP-asserted MFA / AAL floor (`requiredAcr`) can't be bypassed.

**The risk:** if the org's IdP is **down or misconfigured** AND Google is disabled
by enforcement, ordinary members are **locked out** — there is no in-app local
password fallback (by design; v2 stores no passwords).

**Interim recovery (implemented):** a platform owner whose email is on the
`INTERNAL_ADMINS` env allowlist is **exempt** from the gov SSO guard and can still
log in via Google. This is the documented break-glass path. The exemption is the
*first* check in `googleLoginBlockedByGovSso` (short-circuits before any DB read),
and the platform-owner `/internal` surface (`src/app/internal/layout.tsx`) is
likewise gated only by `INTERNAL_ADMINS`, never by tenant `enforced` policy.

**Follow-on (NOT in this slice):** a hardware-key-gated (WebAuthn/FIDO2)
local-OWNER login, scoped per-org, so a tenant OWNER can recover without relying
on the platform owner. Until that lands, `INTERNAL_ADMINS` is the only escape and
must be treated as a privileged, audited break-glass credential.

Operational guidance: keep at least one `INTERNAL_ADMINS` identity that does NOT
depend on a tenant IdP, and exercise the recovery path before enabling `enforced`
on a production gov tenant.

---

## What shipped in Task 4

- **Login-page routing** (`src/app/login/page.tsx` + `src/app/api/auth/sso/[orgSlug]/status/route.ts`):
  the login UI takes `?org=<slug>`, queries the public SSO-status endpoint
  (`{ enabled, enforced }`, no secrets), shows "Sign in with SSO" when the org has
  an `enabled` IdpConnection, and **hides Google** when the org is GOV +
  `enabled` + `enforced`.
- **Google gov-guard** (`src/app/api/auth/google/callback/route.ts`): rejects the
  Google login (`?error=sso_enforced`, no session minted) when the identity
  belongs to a GOV org with an `enabled && enforced` IdpConnection. `INTERNAL_ADMINS`
  is exempt (break-glass). NOTE: the rejection is a redirect-to-login with an error
  (matching the existing OAuth-redirect UX) rather than a bare HTTP 403 page — the
  security effect (no session) is identical.
- **Session revocation** (`src/lib/auth/session.ts` → `revokeOrgSessions(orgId)`):
  deletes the `Session` rows for all of an org's members and marks the org's
  `SessionRecord`s REVOKED. Wired into the security-settings `PUT`
  (`src/app/api/v1/orgs/[orgId]/security/settings/route.ts`) so that when a GOV org
  TIGHTENS posture (`ssoEnforced` or `mfaRequired` false→true) existing
  weaker-assurance sessions are terminated. `TODO(sso-followon)` left for SCIM
  `active:false` / OIDC SLO to also call it (per-user scope).
- **compose env** (`.env.example` + `docker-compose.yml`): `SSO_VAULT_KEY`
  (32-byte base64) added with a Docker-secret-in-prod comment; the `cosmos` app
  service receives it via `env_file: .env`.
- **SSP** (`compliance/ssp/control-coverage.csv` + `SSP.md`): IA-2/3.5.3, 3.5.4,
  3.7.5, plus the SSO POA&M item moved `planned → partial` (OIDC RP + acr/amr gov
  floor shipped; SAML/PIV-CAC via Keycloak + WebAuthn still planned).

---

## Dex OIDC round-trip — Docker acceptance runbook

A throwaway `dexidp/dex` (OSS OIDC IdP) drives a real authorize→callback login
against the running stack. Artifacts live in `docs/sso-acceptance/` (the dex
override `docker-compose.dex.yml` is gitignored — it holds a throwaway client
secret + a test-user password hash; never commit it).

Steps (see `docs/sso-acceptance/run-dex-acceptance.sh` for the scripted version):

1. Generate a vault key: `openssl rand -base64 32` → `SSO_VAULT_KEY` in `.env`.
2. Build images: `sudo docker build -t cosmos-v2:dev .` and
   `sudo docker build --target migrate -t cosmos-v2-migrate:dev .`.
3. `sudo docker compose -f docker-compose.yml -f docker-compose.dex.yml up -d`
   (dex serves its issuer on the compose network; cosmos discovers it).
4. Seed a test `Organization` (slug + tenantClass) + an `IdpConnection`
   (`issuerUrl` = dex issuer, `clientId`, `clientSecretEnc` sealed via the vault,
   `jitProvisioning=true`) — `docs/sso-acceptance/seed.ts` (run via the migrate
   image's tsx).
5. Drive with curl + a cookie jar: `GET /api/auth/sso/<slug>/login` → follow to
   dex → POST the dex login form → land on `/api/auth/sso/<slug>/callback`.
6. Assert: a `session` cookie is set; a `FederatedIdentity` row (matched by
   subject) + an `OrgMember` row exist; an `auth.sso.login` `audit_logs` row was
   written; the `Session` row has `auth_method='oidc'`.
7. Tear down: `sudo docker compose -f docker-compose.yml -f docker-compose.dex.yml down -v`.

See the Task 4 report (and `git log`) for which acceptance level was actually
observed in this run.
