import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";
import { emailDomainAllowed } from "@/lib/auth/allowed-domains";
import { maskEmail } from "@/lib/auth/mask-email";
import { createOrgInvitation } from "@/lib/auth/create-invitation";
import type { SignInMethod } from "@/lib/auth/invite-credentials";
import { AccountRequestMode, AccountRequestStatus, OrgRole } from "@prisma/client";
import { escapeLike } from "@/lib/query/like";

/**
 * Why a request to join an org was or wasn't queued. For the OPERATOR and the
 * audit trail only — the public endpoint answers identically in every case, so
 * none of this tells an outsider whether an org exists, what its policy is, or
 * who already has an account. Same reasoning as the password-reset outcomes.
 */
export type SubmitOutcome =
  | "queued"
  | "no_such_org"
  | "malformed_email"
  | "mode_off"
  | "domain_not_allowed"
  | "already_member"
  | "already_pending";

export interface SubmitResult {
  outcome: SubmitOutcome;
  /** Set only when a row was actually written. */
  requestId?: string;
  orgId?: string;
}

/**
 * Record someone asking an org for an account.
 *
 * Writes NOTHING that grants access: the row is a queue entry, and only an
 * admin approving it mints an invitation. A missing OrgSecuritySettings row
 * means OFF — the secure default is "this org never asked for a request form".
 */
export async function submitAccountRequest(params: {
  orgSlug: string;
  email: string;
  note?: string | null;
  ipAddress?: string | null;
}): Promise<SubmitResult> {
  const email = params.email.trim().toLowerCase();

  // Validated HERE as well as at the route. This function is exported, and the
  // domain allowlist below must not depend on a check in a caller it cannot
  // see — the allowlist reads the domain after the last "@", so a malformed
  // address should never reach it in the first place.
  if (!z.string().email().max(320).safeParse(email).success) {
    return { outcome: "malformed_email" };
  }

  const org = await prisma.organization.findUnique({
    where: { slug: params.orgSlug },
    select: { id: true, securitySettings: { select: { accountRequestMode: true, allowedDomains: true } } },
  });
  if (!org) return { outcome: "no_such_org" };

  // A missing settings row is OFF, not "unrestricted".
  const mode = org.securitySettings?.accountRequestMode ?? AccountRequestMode.OFF;
  if (mode === AccountRequestMode.OFF) return { outcome: "mode_off", orgId: org.id };

  if (mode === AccountRequestMode.ALLOWLIST) {
    const domains = (org.securitySettings?.allowedDomains ?? [])
      .map((d) => d.trim())
      .filter(Boolean);
    // Fail CLOSED on a configuration that cannot mean what it says: an empty
    // list is "unrestricted" everywhere else, so ALLOWLIST with no domains
    // would accept every address while reading as locked down. The settings
    // route refuses to create that state; this refuses to honour it if it
    // arrives some other way.
    if (domains.length === 0) return { outcome: "domain_not_allowed", orgId: org.id };
    if (!emailDomainAllowed(email, domains)) {
      return { outcome: "domain_not_allowed", orgId: org.id };
    }
  }

  // Someone who is already a member has nothing to ask for. Checked so the
  // queue doesn't fill with people who should be told to sign in instead.
  const existing = await prisma.user.findFirst({
    where: { email: { equals: escapeLike(email), mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) {
    const member = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: org.id, userId: existing.id } },
      select: { userId: true },
    });
    if (member) return { outcome: "already_member", orgId: org.id };
  }

  // At most one PENDING row per address per org, enforced by a partial unique
  // index. Caught rather than pre-checked so two simultaneous submissions
  // can't both pass a check and then collide.
  try {
    const row = await prisma.accountRequest.create({
      data: {
        orgId: org.id,
        email,
        note: params.note?.trim() || null,
        modeAtRequest: mode,
        ipAddress: params.ipAddress ?? null,
      },
      select: { id: true },
    });
    return { outcome: "queued", requestId: row.id, orgId: org.id };
  } catch (e) {
    if (isUniqueViolation(e)) return { outcome: "already_pending", orgId: org.id };
    throw e;
  }
}

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "P2002";
}

/**
 * Log + audit a submission. Split from the write so the endpoint stays a thin
 * shell, and so the address is masked everywhere it could be an arbitrary
 * string from an unauthenticated caller — see maskEmail.
 */
export async function recordSubmitOutcome(params: {
  result: SubmitResult;
  orgSlug: string;
  email: string;
  ipAddress?: string | null;
}): Promise<void> {
  const { result } = params;
  // `queued` and `already_member` are the only outcomes where the address has a
  // real relationship with this org; everything else is an unauthenticated
  // caller's string and is masked.
  const known = result.outcome === "queued" || result.outcome === "already_member";
  const who = known ? params.email.toLowerCase() : maskEmail(params.email);
  console.info(`[account-request] ${result.outcome} for ${who} (org ${params.orgSlug})`);

  // Only an org that actually exists has somewhere to attribute this, and only
  // a queued request is worth a durable row — the rest would let an outsider
  // write into an org's audit log by POSTing.
  if (result.orgId && result.outcome === "queued") {
    try {
      await logAudit({
        orgId: result.orgId,
        action: "account_request.submitted",
        entity: "account_request",
        entityId: result.requestId,
        metadata: { email: params.email.toLowerCase() },
        ipAddress: params.ipAddress ?? undefined,
      });
    } catch (e) {
      // eslint-disable-next-line no-restricted-syntax -- operator-facing, best-effort
      console.error(`[account-request] audit write failed for ${who}:`, e);
    }
  }
}

export const REQUEST_NOT_PENDING = "That request is no longer pending.";

export interface ApproveResult {
  acceptUrl: string;
  emailSent: boolean;
  emailError: string | null;
  existingAccount: boolean;
}

/**
 * Approve a pending request: mint an invitation through the ONE shared path and
 * record who decided.
 *
 * The caller must already have checked authorization. The request row is
 * CLAIMED first with a conditional update, so two admins approving at the same
 * moment cannot both mint an invitation; if minting then fails the claim is
 * released, because a request marked approved with nothing sent is the worse
 * of the two failures.
 */
export async function approveAccountRequest(params: {
  orgId: string;
  orgName: string;
  orgSlug: string;
  requestId: string;
  /** The admin's per-request choice: an invitation link, or a temp password. */
  signInMethod: SignInMethod;
  mfaRequired: boolean;
  actorUserId: string;
  /** The approver's own org role, which bounds what approval can grant. */
  actorOrgRole: OrgRole;
  /** The approver's base permissions, the ceiling for the role approval grants. */
  actorBasePermissions: bigint;
  actorDisplayName: string | null;
  origin: string;
  ipAddress?: string | null;
}): Promise<ApproveResult> {
  const req = await prisma.accountRequest.findFirst({
    where: { id: params.requestId, orgId: params.orgId },
    select: { id: true, email: true, status: true },
  });
  if (!req) throw new NotPending();
  if (req.status !== AccountRequestStatus.PENDING) throw new NotPending();

  // Re-check the domain policy at DECISION time: the allowlist may have been
  // tightened since the request was taken, and the queue entry is not a
  // standing exemption from it.
  const sec = await prisma.orgSecuritySettings.findUnique({
    where: { orgId: params.orgId },
    select: { accountRequestMode: true, allowedDomains: true },
  });
  if (
    sec?.accountRequestMode === AccountRequestMode.ALLOWLIST &&
    !emailDomainAllowed(req.email, sec.allowedDomains)
  ) {
    throw new DomainNowDisallowed();
  }

  const claimed = await prisma.accountRequest.updateMany({
    where: { id: req.id, orgId: params.orgId, status: AccountRequestStatus.PENDING },
    data: {
      status: AccountRequestStatus.APPROVED,
      decidedAt: new Date(),
      decidedById: params.actorUserId,
    },
  });
  if (claimed.count !== 1) throw new NotPending();

  let result;
  try {
    result = await createOrgInvitation({
      orgId: params.orgId,
      orgName: params.orgName,
      orgSlug: params.orgSlug,
      email: req.email,
      // Approval always mints a plain MEMBER. Handing out a role here would
      // need the same ceiling check promoting someone does, and an approval
      // screen is the wrong place for that decision -- the admin adjusts the
      // role on the member once they have joined, through the members route
      // that already enforces it. Same reasoning as work-roles, which
      // approval also does not accept.
      role: OrgRole.MEMBER,
      signInMethod: params.signInMethod,
      mfaRequired: params.mfaRequired,
      actorUserId: params.actorUserId,
      actorOrgRole: params.actorOrgRole,
      actorBasePermissions: params.actorBasePermissions,
      actorDisplayName: params.actorDisplayName,
      origin: params.origin,
      ipAddress: params.ipAddress,
      auditExtra: { accountRequestId: req.id },
    });
  } catch (e) {
    // Release the claim so the request stays actionable rather than being
    // stranded as "approved" with no invitation behind it.
    await prisma.accountRequest.updateMany({
      where: { id: req.id, orgId: params.orgId, status: AccountRequestStatus.APPROVED },
      data: { status: AccountRequestStatus.PENDING, decidedAt: null, decidedById: null },
    });
    throw e;
  }

  await prisma.accountRequest.update({
    where: { id: req.id },
    data: { invitationId: result.invitation.id },
  });

  await logAudit({
    orgId: params.orgId,
    userId: params.actorUserId,
    action: "account_request.approved",
    entity: "account_request",
    entityId: req.id,
    metadata: {
      email: req.email,
      signInMethod: result.effectiveSignInMethod,
      invitationId: result.invitation.id,
      emailSent: String(result.emailSent),
    },
    ipAddress: params.ipAddress ?? undefined,
  });

  return {
    acceptUrl: result.acceptUrl,
    emailSent: result.emailSent,
    emailError: result.emailError,
    existingAccount: result.existingAccount,
  };
}

/** Deny a pending request. The row is kept: a denial is a decision, not a gap. */
export async function denyAccountRequest(params: {
  orgId: string;
  requestId: string;
  actorUserId: string;
  ipAddress?: string | null;
}): Promise<void> {
  const denied = await prisma.accountRequest.updateMany({
    where: { id: params.requestId, orgId: params.orgId, status: AccountRequestStatus.PENDING },
    data: {
      status: AccountRequestStatus.DENIED,
      decidedAt: new Date(),
      decidedById: params.actorUserId,
    },
  });
  if (denied.count !== 1) throw new NotPending();

  await logAudit({
    orgId: params.orgId,
    userId: params.actorUserId,
    action: "account_request.denied",
    entity: "account_request",
    entityId: params.requestId,
    ipAddress: params.ipAddress ?? undefined,
  });
}

/** The request was decided by someone else, or never existed in this org. */
export class NotPending extends Error {
  constructor() {
    super(REQUEST_NOT_PENDING);
    this.name = "NotPending";
  }
}

/** The allowlist was tightened after the request was taken. */
export class DomainNowDisallowed extends Error {
  constructor() {
    super("That address is no longer on this organization's allowed domains.");
    this.name = "DomainNowDisallowed";
  }
}
