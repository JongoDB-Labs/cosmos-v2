# Email/password invite + onboarding

Adds an **email/password** sign-in option to invitations, alongside the existing
**OAuth** flow (never replacing it). For email/password invites the app generates
a strong random password, emails it, and forces a password change (and optional
MFA enrollment) at first sign-in — before any session is minted.

Branch: `invite-email-password` · Worktree: `/home/ubuntu/cosmos-invite-feature`

---

## 1. Auth-architecture findings (how login actually works)

The app is **multi-method**, not Keycloak-only. Login paths:

| Method | Entry | Notes |
|---|---|---|
| Google OAuth | `src/app/api/auth/google/callback/route.ts` | JIT-provisions the user; consumes invites |
| Microsoft OAuth | `src/app/api/auth/microsoft/*` | same shape |
| Per-org SSO / OIDC (Keycloak etc.) | `src/app/api/auth/sso/[orgSlug]/*`, `IdpConnection` model | can be `enforced` (gov SSO-only) |
| **Local email + password** | `src/app/api/auth/password/login/route.ts` | **already existed** — scrypt in `src/lib/auth/password.ts` |
| **TOTP MFA** | `src/app/api/auth/password/mfa/route.ts` | **already existed** — `src/lib/auth/totp.ts` (+ recovery codes) |

Key consequences that shaped the design:

- **A first-party local-credential path already exists** (`User.passwordHash`
  scrypt, `passwordSetAt`, `mfaEnabled/mfaSecret/mfaRecoveryCodes`). So
  email/password invites did **NOT** require provisioning users inside Keycloak
  or a new insecure auth path — we reuse the existing scrypt + TOTP primitives.
- **Invitations** (`Invitation` model) are *pending grants*, not accounts. They
  were consumed **only** by the OAuth callbacks via
  `consumePendingInvitations()` (`src/lib/auth/consume-invitations.ts`), which
  creates the `OrgMember` + work-roles + joins `#general`. The password-login
  route did **not** consume them — a gap this change closes.
- **The invite email assumed OAuth** ("Sign in with your Google account").
- MFA is enforced for password logins **at the login boundary** (a password
  session only counts as MFA-satisfied once TOTP completes; `sessionSatisfiesMfa`
  in `src/lib/auth/session.ts:17`). Enforcing a *per-user* MFA requirement purely
  at the `getAuthContext` gate would **redirect-loop** (`team/page.tsx → "/" →
  /[slug] → denied → …`), so forced MFA has to happen **at login**, like the
  forced password change.

## 2. Design

Additive schema (migration `20260713170000_email_password_invite`):

- `User.mustChangePassword` (bool) — force temp-password rotation at first login.
- `User.mfaRequired` (bool) — per-user MFA floor set at invite time.
- `Invitation.signInMethod` (`"oauth"` default | `"email_password"`).
- `Invitation.mfaRequired` (bool) — records what the invite asked for.

Flow for an `email_password` invite:

1. **Invite** (`POST /api/v1/orgs/[orgId]/invitations`) gains `signInMethod` +
   `mfaRequired`. For email/password it calls
   `provisionEmailPasswordInvite()` (`src/lib/auth/invite-credentials.ts`):
   generates a strong password (`src/lib/auth/temp-password.ts`, `node:crypto`
   `randomInt`, 22 chars over a 58-symbol unambiguous alphabet ≈128 bits),
   scrypt-**hashes** it, sets `mustChangePassword` + `mfaRequired`, and returns
   the plaintext **once** to be emailed (`sendPasswordInviteEmail`). The temp
   password is **never logged** and only stored as a hash.
   - Existing users are protected: an account that **already has a password is
     never clobbered** by a re-invite (returns `tempPassword: null`).
2. **First login** is a server-driven state machine (sealed `first_login`
   cookie, same primitive as the existing MFA-pending cookie — *no session is
   minted until onboarding completes*):
   - `password/login` verifies the temp password, then returns the next owed
     step instead of a session: `change_password` → `enroll_mfa` → session.
   - `password/first-login/change` — set a new password (must differ from the
     temp; ≥12 chars), clear `mustChangePassword`.
   - `password/first-login/mfa-setup` / `mfa-enroll` — forced TOTP enrollment
     (QR on the login page), then mint an **mfaSatisfied** session + one-time
     recovery codes. Ordering is enforced (password before MFA).
   - Session minting now runs `consumePendingInvitations()` (via
     `finishPasswordLogin()` in `local-session.ts`), so email/password invitees
     get their membership — parity with the OAuth callbacks (the `/mfa` route
     now consumes too).
3. **UI**: invite dialog gets a sign-in-method select + "Require two-factor"
   checkbox and shows the temp password once (delivery fallback). The login page
   drives the change-password / enroll-MFA / recovery-codes phases.

OAuth invites are unchanged: default `signInMethod:"oauth"`, no credential
provisioned, `tempPassword: null`, same email + `consumePendingInvitations`.

## 3. Implemented + tested

New: `temp-password.ts`, `invite-credentials.ts`, `first-login.ts`,
`first-login/{change,mfa-setup,mfa-enroll}/route.ts`, migration.
Modified: invite route, `password/login` + `password/mfa` routes,
`local-session.ts`, `invitation-email.ts`, login page, invite dialog, schema.

Tests (all green; `tsc --noEmit` clean; eslint clean):

- `temp-password.test.ts` — policy-safe, crypto alphabet, no collisions.
- `invite-credentials.test.ts` — hashes temp pw (never raw), sets flags, never
  clobbers an existing password.
- `first-login.test.ts` — step ordering + sealed-cookie open/expiry.
- `invitations/route.test.ts` (real DB) — email_password provisions the
  credential + flags + records method; **OAuth path unchanged** (no credential,
  `tempPassword: null`).
- `first-login-flow.test.ts` (real DB, real handlers) — temp password yields **no
  session**; change mints one; new-pw-equals-temp rejected; **MFA-required forces
  enrollment → mfaSatisfied session**; enrollment blocked before password change.

## 4. Auth decisions that want a human

1. **Temp password shown to the admin (once) in the invite response/UI** as a
   delivery fallback when the Gmail send fails. It is HTTPS-only, unlogged, and
   force-rotated — but it does mean the inviting admin can see the initial
   secret. If policy forbids this, drop `tempPassword` from the API response and
   rely on email delivery only (accepting that a failed send needs a resend).
2. **Per-user `mfaRequired` is enforced at the login boundary, not the
   `getAuthContext` gate** (to avoid the redirect loop). Consequence: flipping
   `mfaRequired` on a user who already has a live non-MFA session takes effect on
   their **next** login; to force it immediately, revoke their sessions
   (`revokeOrgSessions`). A dedicated post-login "/security/setup" gate page
   could enforce it mid-session — deferred as a UX decision.
3. **Email transport** reuses the inviter's Gmail mailbox (`gmail.send`), same as
   today. An inviter without a connected Google mailbox can still create the
   invite (email fails gracefully; admin shares the temp password). A
   system/transactional mailer would remove that dependency.
4. **Shared e2e DB**: it was already migrated ahead of this branch by other
   worktrees, so the four additive columns were applied out-of-band
   (idempotent `ADD COLUMN IF NOT EXISTS`) to enable tests; the committed
   migration uses standard Prisma `ADD COLUMN` for fresh/CI databases.

---

## 5. Security remediation (2026-07-13)

Two findings from the security review of this branch are now fixed, plus two
cheap correctness items. Invariant added: **an invite NEVER writes
`passwordHash`/`mustChangePassword`/`mfaRequired` onto a pre-existing User** — the
only credential write is a brand-new `user.create`.

### #1 — Cross-tenant account takeover (CRITICAL, fixed)
An `email_password` invite used to *attach* an admin-generated password to an
existing account (the `if (existing)` / OAuth-only branch in
`provisionEmailPasswordInvite`). Because sessions are user-global, any member
could self-create an org (→ OWNER), invite an existing OAuth-only user
(`victim@othertenant.com`) as `email_password`, and take over that account
everywhere.

- `src/lib/auth/invite-credentials.ts`: `provisionEmailPasswordInvite` now
  provisions **only brand-new accounts**. If the email resolves to ANY existing
  User (case-insensitive) it throws `ConflictError`
  (`EMAIL_PASSWORD_INVITE_EXISTING_USER`) and writes nothing. The OAuth-only
  "attach credential" and "existing password" branches are deleted.
- `invitations/route.ts`: rejects an `email_password` invite for a known email
  with **409** *before* the allowlist upsert (rejected invite leaves no trace).
  Existing users are still invitable via **OAuth** (unchanged pending-invite
  grant). The in-transaction re-check makes it TOCTOU-safe.

### #2 — Plaintext temp password leaked in the API response (fixed)
`invitations/route.ts` no longer returns `tempPassword` in the `created({...})`
body. The secret is delivered **only** by email (`sendPasswordInviteEmail`).
`invite-member-button.tsx` drops the temp-password display/copy entirely; on a
failed send it shows a note pointing to the existing **"Resend invite"**
affordance (team list) instead of any secret. This supersedes "Auth decision #1"
above.

### Cheap fixes
- **Orphan-User ordering**: the credential provision + `invitation.create` now
  run in a single `prisma.$transaction`, so a failure on either side rolls both
  back — no orphan User (password hash, no invite) and no dangling invite.
- **Alphabet comment** in `temp-password.ts`: the set is 57 chars (base58 minus
  `1`), not 58; comment corrected (entropy ≈128 bits unchanged).

### Tests (all green) + `tsc --noEmit` clean
- `invite-credentials.test.ts` — rewritten: brand-new account still hashes +
  force-rotates + threads MFA; an existing user (OAuth-only **and**
  has-password) is **rejected with no create/update**.
- `invitations/route.test.ts` — response asserted to **not** contain
  `tempPassword`; **new takeover test**: an `email_password` invite for a
  pre-existing (non-member) user → **409**, victim's `passwordHash`/
  `mustChangePassword`/`mfaRequired`/`passwordSetAt` untouched, and no invitation
  or allowlist row created. OAuth + brand-new paths unchanged.
- `first-login-flow.test.ts` — forced-first-login state machine unchanged.

### Known limitation (not a regression)
If the **first** email of a brand-new `email_password` invite fails to send, the
temp password is unrecoverable (hash-only, no longer in the response). The
existing "Resend invite" endpoint re-sends the OAuth-style email and does **not**
re-issue a temp password — deliberately, to preserve the "no invite writes a
credential onto an existing User" invariant. Operationally, recovery is to revoke
the un-onboarded invite + account and re-create. A dedicated, tightly-gated
"re-issue temp password for an un-onboarded invitee" path could close this, but
was left out of scope to keep the security invariant auditable.
