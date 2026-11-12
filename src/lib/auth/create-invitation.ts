import { prisma } from "@/lib/db/client";
import { ConflictError, ForbiddenError } from "@/lib/rbac/check";
import { assertCanGrantOrgRole } from "@/lib/rbac/grant-ceiling";
import { emailDomainAllowed } from "@/lib/auth/allowed-domains";
import { logAudit } from "@/lib/audit";
import {
  sendInvitationEmail,
  sendPasswordInviteEmail,
} from "@/lib/integrations/invitation-email";
import { provisionEmailPasswordInvite, type SignInMethod } from "@/lib/auth/invite-credentials";
import type { Invitation, OrgRole } from "@prisma/client";

export const ALREADY_A_MEMBER = "User is already a member";

export interface CreateOrgInvitationParams {
  orgId: string;
  orgName: string;
  orgSlug: string;
  /** Lowercased by the caller's schema; lowercased again here defensively. */
  email: string;
  role: OrgRole;
  workRoleIds?: string[];
  signInMethod: SignInMethod;
  mfaRequired: boolean;
  /** The admin doing this: mail is sent as them, and the audit row is theirs. */
  actorUserId: string;
  /** The admin's OWN org role, which bounds the role they may hand out. */
  actorOrgRole: OrgRole;
  /** The admin's base permissions (role plus override, never work-role grants):
   *  the invited role's permissions must fit inside them. */
  actorBasePermissions: bigint;
  actorDisplayName: string | null;
  /** Public origin, for the accept/login link. */
  origin: string;
  ipAddress?: string | null;
  /** Folded into the audit row — e.g. the account request this came from. */
  auditExtra?: Record<string, string>;
}

export interface CreateOrgInvitationResult {
  invitation: Invitation;
  acceptUrl: string;
  emailSent: boolean;
  emailError: string | null;
  /** The address already had a User, so no admin credential was set on it. */
  existingAccount: boolean;
  /** What was actually written, which is coerced to "oauth" for an existing account. */
  effectiveSignInMethod: SignInMethod;
}

/**
 * Create an org invitation, provisioning a local credential only when that is
 * safe, mail it, and audit it.
 *
 * This is deliberately ONE function with more than one caller. An admin
 * inviting someone and an admin approving an account request must mint accounts
 * by exactly the same path, because the rule below is a security boundary and a
 * second copy of it is a second thing to forget:
 *
 * SECURITY (cross-tenant account takeover): a credential is provisioned only
 * when email_password was asked for AND the address is a brand-new account. An
 * admin must never attach an admin-generated credential (passwordHash /
 * mustChangePassword / mfaRequired) to a PRE-EXISTING account — sessions are
 * user-global, so that would hand the inviter that user's access everywhere. A
 * pre-existing account falls back to the ordinary invitation, consumed at their
 * next sign-in, and the caller is told via `existingAccount`.
 *
 * Callers remain responsible for authorization, for the email-domain
 * allowlist, and for validating any work-roles against their own ceiling —
 * those depend on who is asking, which this function deliberately doesn't know.
 */
export async function createOrgInvitation(
  p: CreateOrgInvitationParams,
): Promise<CreateOrgInvitationResult> {
  const email = p.email.trim().toLowerCase();
  const workRoleIds = p.workRoleIds ?? [];

  // Only an OWNER may hand out the OWNER role, and nobody may hand out a role
  // whose permissions go beyond their own base permissions. Without the first,
  // an ADMIN holding ORG_MANAGE_MEMBERS could invite an address they control as
  // OWNER, accept it, and gain the OWNER-only bits (ORG_DELETE,
  // ORG_MANAGE_BILLING). Without the second, a member given ORG_MANAGE_MEMBERS
  // by a work role could invite an ADMIN.
  //
  // The same rule (grant-ceiling.ts) guards the members routes. It lives here,
  // not in a route, so both the invitations endpoint and account-request
  // approval are covered by one copy.
  assertCanGrantOrgRole(
    { orgRole: p.actorOrgRole, basePermissions: p.actorBasePermissions },
    p.role,
  );

  // The org's email-domain restriction, enforced for EVERY way an account is
  // minted. An empty list is unrestricted, as everywhere else.
  //
  // This was a route-level check only, so approving an account request could
  // mint an invitation for an address the invitations endpoint would refuse
  // outright: the request modes (ALLOWLIST / OPEN) govern what may be
  // SUBMITTED, and reading the mode at decision time made the restriction
  // conditional on it. It is not — it bounds who may newly join, full stop.
  // The invitations route keeps its own copy for the friendlier message that
  // names the domains; this one is the guarantee.
  const sec = await prisma.orgSecuritySettings.findUnique({
    where: { orgId: p.orgId },
    select: { allowedDomains: true },
  });
  if (!emailDomainAllowed(email, sec?.allowedDomains)) {
    throw new ForbiddenError("That address is not on this organization's allowed domains");
  }

  // Case-insensitive so a differently-cased row can't slip past the guards
  // below (matches provisionEmailPasswordInvite's own lookup).
  const existingUser = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
  });
  if (existingUser) {
    const existingMember = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId: p.orgId, userId: existingUser.id } },
    });
    if (existingMember) throw new ConflictError(ALREADY_A_MEMBER);
  }

  const existingAccount = Boolean(existingUser);
  const provisionPassword = p.signInMethod === "email_password" && !existingAccount;
  const effectiveSignInMethod: SignInMethod = provisionPassword ? "email_password" : "oauth";

  // Auto-allowlist so the recipient's first sign-in passes the gate. The OAuth
  // callback consumes pending invitations on its own.
  await prisma.allowedEmail.upsert({
    where: { email },
    update: {},
    create: { email, addedBy: p.actorUserId },
  });

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  // Provision the local credential (email/password only) and create the
  // invitation row in ONE transaction: a failure on either side rolls both
  // back, so we never leave an orphan User (password hash, no invite) nor a
  // dangling invite. provisionEmailPasswordInvite re-checks for an existing
  // user inside the tx and throws if one appeared since the guard above
  // (TOCTOU-safe). The returned tempPassword is emailed only, never logged.
  let tempPassword: string | null = null;
  const invitation = await prisma.$transaction(async (tx) => {
    if (provisionPassword) {
      const provisioned = await provisionEmailPasswordInvite({
        email,
        mfaRequired: p.mfaRequired,
        client: tx,
      });
      tempPassword = provisioned.tempPassword;
    }
    return tx.invitation.create({
      data: {
        orgId: p.orgId,
        email,
        role: p.role,
        workRoleIds,
        expiresAt,
        // For a pre-existing account this is coerced to "oauth" (no credential
        // was provisioned) so the invariant "signInMethod === email_password ⇒
        // a temp password exists" holds and the resend flow stays consistent.
        signInMethod: effectiveSignInMethod,
        mfaRequired: p.mfaRequired,
      },
    });
  });

  // OAuth invitees accept via a sign-in link; email/password invitees go to the
  // branded login screen and sign in with their credentials.
  const acceptUrl = provisionPassword
    ? `${p.origin}/login?org=${encodeURIComponent(p.orgSlug)}`
    : `${p.origin}/login?invite=${invitation.token}`;

  let emailSent = false;
  let emailError: string | null = null;
  if (p.actorDisplayName !== null) {
    try {
      // An invitee who already has a LOCAL password signs in with it, not with
      // Google. Sending them the OAuth email told such users to "sign in with
      // your Google account" for an account that has no Google identity -- an
      // instruction that cannot be followed. Route them to the password email
      // instead, with a pointer to the reset form, since a forgotten password
      // is the likeliest reason they are stuck.
      //
      // No credential is provisioned and none is quoted: the rule that an
      // admin may never set a password on a pre-existing account (see
      // `provisionPassword`) is untouched.
      if (!provisionPassword && existingUser?.passwordHash) {
        await sendPasswordInviteEmail({
          fromUserId: p.actorUserId,
          orgId: p.orgId,
          toEmail: email,
          orgName: p.orgName,
          inviterName: p.actorDisplayName,
          loginUrl: acceptUrl,
          tempPassword: null,
          mfaRequired: p.mfaRequired,
          // Deliberately NOT folded into `acceptUrl`: that is returned to the
          // ADMIN. This belongs only in the invitee's mail.
          resetUrl: `${p.origin}/login?forgot=1`,
        });
      } else if (provisionPassword) {
        await sendPasswordInviteEmail({
          fromUserId: p.actorUserId,
          orgId: p.orgId,
          toEmail: email,
          orgName: p.orgName,
          inviterName: p.actorDisplayName,
          loginUrl: acceptUrl,
          tempPassword,
          mfaRequired: p.mfaRequired,
        });
      } else {
        await sendInvitationEmail({
          fromUserId: p.actorUserId,
          orgId: p.orgId,
          toEmail: email,
          orgName: p.orgName,
          inviterName: p.actorDisplayName,
          acceptUrl,
        });
      }
      emailSent = true;
    } catch (e) {
      // Don't fail the invite creation — the admin can resend or copy the link.
      emailError = e instanceof Error ? e.message : "send_failed";
    }
  }

  await logAudit({
    orgId: p.orgId,
    userId: p.actorUserId,
    action: "invitation.created",
    entity: "invitation",
    entityId: invitation.id,
    // NB: the temporary password is NEVER written to the audit log.
    metadata: {
      email,
      role: p.role,
      signInMethod: effectiveSignInMethod,
      existingAccount: String(existingAccount),
      mfaRequired: String(p.mfaRequired),
      emailSent: String(emailSent),
      ...(emailError ? { emailError } : {}),
      ...(p.auditExtra ?? {}),
    } as Record<string, string>,
    ipAddress: p.ipAddress ?? undefined,
  });

  return { invitation, acceptUrl, emailSent, emailError, existingAccount, effectiveSignInMethod };
}
