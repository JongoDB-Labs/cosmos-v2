# Tenant class (GOV/COMMERCIAL) selector — investigation, and why I stopped short of building it

## The ask

Add an API + org-settings UI control so an org **OWNER** can change
`Organization.tenantClass` (the enum that drives the CUI-blind egress gate) between
`GOV` and `COMMERCIAL`, gated at least as strictly as `ORG_MANAGE_SETTINGS` /
preferably the OWNER base role, with a prominent warning that COMMERCIAL removes
CUI-blind masking.

## What I found: this exact capability already exists, deliberately restricted to
## PLATFORM owners, and the codebase documents *why tenant owners must not have it*

Before writing any code I read the enum and the gate, as instructed, then went
looking for "the pattern" in `src/app/api/v1/orgs/[orgId]/` the task pointed me at.
That search surfaced a **second, separate route outside that tree** that already
does exactly what was asked, for a deliberately different actor:

- **`src/app/api/internal/orgs/[orgId]/tenant-class/route.ts`** — `GET`/`PATCH` on
  `tenantClass`, gated by `requirePlatformOwner()` (`isInternalAdmin(email,
  INTERNAL_ADMINS)` — `src/lib/internal/access.ts`), **not** by any org role or
  `OrgMember` permission. The file's own header comment (lines 10–14):

  > "The GOV designation is a PLATFORM-OWNER decision (design §8): only an internal
  > admin (`isInternalAdmin` against `INTERNAL_ADMINS`) may flip an org's
  > `tenantClass`. **A tenant-admin can NEVER reach this route** (it lives under
  > `/api/internal`, gated below)."

  A flip to `GOV` atomically runs `applyGovGuardrails` (`src/lib/runtime-config/guardrails.ts`)
  in the same transaction (forces `breadthEnabled=false`, `mcpEnabled=false`, strips
  commercial-only connectors) and audits `tenant_class.changed`.

- **`src/app/api/internal/orgs/[orgId]/tenant-class/route.test.ts`** — its own header
  comment: "Proves: a NON-internal-admin (incl. a tenant-admin) gets 403 — a
  tenant-admin can NEVER flip." Test at lines 55–62 asserts exactly that.

- **`compliance/ssp/SSP.md:124`** (AC-3, access control family) documents this as an
  *implemented, audited control*, not an incidental gate:

  > "Privilege separation for the runtime-config surface (3.1.4 / 3.1.5 — AC-3). The
  > gov designation and its guardrails are a **PLATFORM-OWNER authority**
  > (`isInternalAdmin`), strictly separated from the **TENANT-ADMIN**
  > connector-enablement authority (`INTEGRATION_MANAGE`): **a tenant-admin can read
  > `tenantClass` but can NEVER flip it** ... This makes the gov→commercial-breadth
  > boundary a **least-privilege, separation-of-duties control rather than a
  > single-role toggle**."

  `SSP.md:141` (CM-7, config management family) repeats it with more detail, and the
  versioned changelog at `SSP.md:251` records it as a shipped, reviewed feature:
  `2026-06-07 | 2.22.0 | ... platform-owner-only tenantClass flip with atomic gov
  guardrails ...`.

- **git history**: the internal route was introduced in one deliberate commit,
  `4312468 feat(runtime-config): tenantClass gov guardrails + APIs + RBAC` — not a
  stub or a TODO.

- **`src/components/settings/org-general-settings.tsx:37-41`**, the exact component
  this task asked me to extend, already has a docstring: "Plan, tenant class, and
  the org ID are shown for reference but **never editable here**," and the tenant
  class is rendered read-only (lines 164-173). Someone already made this call in
  the UI layer too.

- **`COSMO-INVESTIGATION.md:110-137`** (the doc this task told me to read for
  context, written during the prior fix on this same branch) already flags this
  exact question — "Is the org actually a GOV tenant, or mis-defaulted to GOV?" —
  and explicitly **declines to change it**: "This is an org-classification decision
  for an admin, not a code change, and I did not touch production data" / "Relaxing
  it is a classification/policy call ... so it is flagged here rather than coded."

Net: `Organization.tenantClass` is not an unfinished feature with no UI — it is a
**shipped, tested, SSP-documented separation-of-duties control** (NIST 800-171
AC-3/CM-7 framing — this SSP is written for a system that is explicitly scoped to
carry CUI, see `compliance/ssp/SSP.md` throughout). Its entire design point is that
the tenant side — including the org's own OWNER — must not be able to unilaterally
turn off the CUI-blind masking boundary for their own org. That is precisely the
capability this task asked me to build and expose in the org settings page.

## Why I did not implement the API/UI as literally specified

The task's own gating instructions ("gate it *at least as* strictly as
`ORG_MANAGE_SETTINGS`; prefer the OWNER base role, **mirroring how the most
sensitive org settings are gated**") assume the strictest existing tenant-facing
gate (`Permission.ORG_DELETE`, which — per `src/lib/rbac/permissions.ts:159-244` —
is the one permission bit `RolePermissions.ADMIN` deliberately omits, making it
OWNER-only by construction, used for org deletion in
`src/app/api/v1/orgs/[orgId]/route.ts:134-185`) is the bar to match. But
`tenantClass` is currently gated **more strictly than that** — it is not reachable
by *any* org role, OWNER included; only `isInternalAdmin` (Cosmos platform staff)
can move it. Building an OWNER-gated route/selector, exactly as asked, would be a
**downgrade** of an existing control, not a match for it: it would let every
org's OWNER (including GOV-tenant OWNERs, i.e. exactly the actors the guardrail
exists to constrain) flip their own org to COMMERCIAL and remove CUI-blind masking
from tool-result content reaching the model — unmasking project/ticket/member
names and other content — with no platform-owner involvement, and it would make the
SSP's AC-3 narrative ("a tenant-admin can NEVER flip it") factually false without
any corresponding compliance-doc update.

I don't think "the owner wants it configurable" was written with this control in
view — the task's framing ("Currently there is NO UI to change it") is only true
tenant-side; there already *is* a way to change it (the internal route), which is
the whole point of the separation. This reads like a case where the request was
made without full visibility into a control this same codebase already built and
documented for exactly this reason, and it's exactly the kind of change
`COSMO-INVESTIGATION.md` flagged as a **human decision, not something to code
unilaterally**. So: I stopped short of the mutation capability rather than ship a
compliance regression, and I'm flagging it here instead, per that same precedent.

**I made no functional/behavioral code changes** — no new API route, no new
mutating endpoint, no edits to `org-general-settings.tsx` or the internal route —
so there is nothing new to typecheck or test beyond this document. `tsc`/vitest
status is unchanged from the branch's existing baseline (I didn't touch source).

## Options going forward (need an explicit call — I'd rather hand you the decision
## than make it silently)

1. **Leave it as-is.** Tenant-facing display stays read-only (already true today);
   tenant class changes stay platform-owner-only via `/api/internal/...`. Zero risk,
   zero new work. Likely right if this ask was made without knowing the internal
   route existed.

2. **Tenant-initiated *request*, platform-owner approval (recommended if you want
   self-service without breaking AC-3).** Add an OWNER-reachable "Request tenant
   class change" action in org settings that does **not** itself mutate
   `tenantClass` — it only records/notifies (e.g. an audit event
   `tenant_class.change_requested` + an email/Slack ping to `INTERNAL_ADMINS`).
   The actual flip still only happens via the existing internal route. This
   satisfies "the owner wants it configurable" as a workflow, while the
   separation-of-duties control (and the SSP language describing it) stays true.
   Small, additive, no change to the compliance posture.

3. **Asymmetric self-service (the narrowest safe widening of the boundary).** Let an
   OWNER flip **COMMERCIAL → GOV** directly (this only ever *increases* masking —
   it can't leak CUI to the model, worst case it's an unwanted/reversible
   connector-guardrail hit to their own org via `applyGovGuardrails`). Keep
   **GOV → COMMERCIAL** (the direction that removes masking) platform-owner-only,
   unchanged. This is a real, if partial, "configurable in org settings" feature
   that never lets a tenant widen their own CUI exposure. If you want this, it's a
   small, well-scoped change and I can build it next with tests, mirroring the
   OWNER-gate pattern from `members/[memberId]/route.ts:34-53` for the explicit
   `ctx.orgRole !== "OWNER"` check plus `requirePermission(ctx,
   Permission.ORG_MANAGE_SETTINGS)` as the base permission.

4. **Ship it exactly as originally asked** (OWNER can flip either direction from org
   settings). Technically straightforward — I have the implementation fully scoped
   (schema/gate need no changes; API mirrors
   `src/app/api/v1/orgs/[orgId]/route.ts` + the OWNER-role guard from
   `members/[memberId]/route.ts`; UI extends `org-general-settings.tsx`) — but this
   removes a documented AC-3/CM-7 separation-of-duties control. If this is genuinely
   what you want, please say so explicitly and also plan an SSP update
   (`compliance/ssp/SSP.md:124,141,251`) so the compliance doc matches reality —
   I'd rather not quietly make an attested control statement false.

## Ready-to-use safety-warning copy (for whichever option lands on a real UI control)

Prominent, near the control, in the same alert style as `OrgDangerZone`
(`AlertTriangle` icon, critical-status color, not a subtle caption):

> **Warning — this changes what the AI model can see.**
> GOV mode masks tool-result content (project names, ticket titles, member names,
> notes, and other free-text content) before it ever reaches the AI model — a
> CUI-blind privacy boundary. Switching this organization to **COMMERCIAL removes
> that mask**: the assistant will see this organization's content unmasked from
> then on. Only choose COMMERCIAL if this organization holds no Controlled
> Unclassified Information (CUI) or other regulated/sensitive data. This change is
> audited.

If option 2 or 4 is chosen and a request/approval step is involved, append:
> Changing **to COMMERCIAL** requires platform approval and will be reviewed before
> it takes effect.

## Files read / cited (no source files modified)

- `prisma/schema.prisma:23-26` (`enum TenantClass`), `:180` (`Organization.tenantClass @default(GOV)`)
- `src/lib/ai/egress/gate.ts:18-54`, `src/lib/ai/egress/types.ts`, `src/lib/ai/egress/index.ts`
- `src/app/api/internal/orgs/[orgId]/tenant-class/route.ts`, `route.test.ts`
- `src/lib/internal/access.ts` (`isInternalAdmin`)
- `src/lib/runtime-config/guardrails.ts` (`applyGovGuardrails`)
- `src/app/api/v1/orgs/[orgId]/route.ts` (PUT/DELETE — the tenant-facing "most
  sensitive setting" pattern: `ORG_UPDATE` / `ORG_DELETE`)
- `src/app/api/v1/orgs/[orgId]/members/[memberId]/route.ts:34-53` (explicit
  `ctx.orgRole !== "OWNER"` guard pattern, layered on top of a permission check)
- `src/lib/rbac/permissions.ts` (`Permission`, `RolePermissions` — `ORG_DELETE` is
  OWNER-only by omission from `ADMIN`)
- `src/lib/rbac/check.ts` (`AuthContext`, `requirePermission`, `ForbiddenError`)
- `src/app/(dashboard)/[orgSlug]/settings/organization/page.tsx`, `page.test.tsx`
- `src/components/settings/org-general-settings.tsx`, `org-danger-zone.tsx`
- `compliance/ssp/SSP.md:124, 141, 251`
- `COSMO-INVESTIGATION.md:110-137`
- git: `4312468 feat(runtime-config): tenantClass gov guardrails + APIs + RBAC`
