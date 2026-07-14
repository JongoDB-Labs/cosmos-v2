import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext, getCurrentUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, isPermissionSubset, maskFromDb } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { getPublicOrigin } from "@/lib/auth/public-url";
import {
  sendInvitationEmail,
  sendPasswordInviteEmail,
} from "@/lib/integrations/invitation-email";
import {
  provisionEmailPasswordInvite,
  SIGN_IN_METHODS,
} from "@/lib/auth/invite-credentials";
import { emailDomainAllowed } from "@/lib/auth/allowed-domains";
import { z } from "zod";
import { OrgRole } from "@prisma/client";

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(OrgRole).default(OrgRole.MEMBER),
  // Optional work-roles to assign on acceptance (granular permission grants +
  // ABAC policies). Validated against the inviter's ceiling below.
  workRoleIds: z.array(z.string().uuid()).max(50).default([]),
  // How the invitee signs in. "oauth" (default) preserves the existing Google/
  // Microsoft/SSO flow; "email_password" provisions a local credential + temp
  // password emailed with the invite.
  signInMethod: z.enum(SIGN_IN_METHODS).default("oauth"),
  // Per-invite MFA floor — enforced (forced TOTP enrollment) at the invitee's
  // first email/password sign-in.
  mfaRequired: z.boolean().default(false),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const invitations = await prisma.invitation.findMany({
      where: { orgId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });

    return success(invitations);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const body = await request.json();
    const data = inviteSchema.parse(body);
    const email = data.email.toLowerCase();

    // Per-org domain restriction: if this org has an allowed-domains list, the
    // invitee's email domain must be in it. Gates only NEW invites — existing
    // members are unaffected — so an owner on another domain can't be locked
    // out. Checked BEFORE the auto-allowlist below so a rejected invite leaves
    // no trace.
    const sec = await prisma.orgSecuritySettings.findUnique({
      where: { orgId },
      select: { allowedDomains: true },
    });
    if (!emailDomainAllowed(email, sec?.allowedDomains)) {
      const list = (sec?.allowedDomains ?? []).join(", ");
      return new Response(
        JSON.stringify({
          error: `${org.name} only allows members from: ${list}. Remove the restriction in Settings → Security to invite other domains.`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Validate any chosen work-roles: each must belong to THIS org, and the
    // inviter may only assign roles whose grants are within their OWN base
    // permissions (same escalation ceiling as direct work-role assignment, so
    // an ORG_MANAGE_MEMBERS holder can't hand out an over-privileged role).
    const workRoleIds = data.workRoleIds ?? [];
    if (workRoleIds.length > 0) {
      const roles = await prisma.workRole.findMany({
        where: { id: { in: workRoleIds }, orgId },
        select: { id: true, grants: true },
      });
      if (roles.length !== new Set(workRoleIds).size) {
        return new Response(
          JSON.stringify({ error: "One or more work-roles don't exist in this org." }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      const overreach = roles.find(
        (r) => !isPermissionSubset(maskFromDb(r.grants), ctx.basePermissions),
      );
      if (overreach) {
        return new Response(
          JSON.stringify({
            error: "You can't assign a work-role that grants permissions you don't have.",
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    const isEmailPassword = data.signInMethod === "email_password";

    // Case-insensitive so a differently-cased row can't slip past the guards
    // below (matches provisionEmailPasswordInvite's own lookup).
    const existingUser = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
    });
    if (existingUser) {
      const existingMember = await prisma.orgMember.findUnique({
        where: {
          orgId_userId: { orgId, userId: existingUser.id },
        },
      });
      if (existingMember) {
        return new Response(
          JSON.stringify({ error: "User is already a member" }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // An email that already resolves to a User is NEVER a dead end. Whatever
    // sign-in method the inviter chose, a pre-existing (non-member) account joins
    // this org through a NORMAL pending invitation — allowlist upsert +
    // invitation.create, consumed at their next sign-in by
    // consumePendingInvitations — and NEVER an admin-set password.
    //
    // SECURITY (cross-tenant account takeover): `provisionPassword` therefore
    // gates on BOTH "email_password was chosen" AND "this is a brand-new
    // account". We must never attach an admin-generated credential
    // (passwordHash / mustChangePassword / mfaRequired) to a pre-existing (e.g.
    // OAuth-only) account — sessions are user-global, so that would hand the
    // inviter that user's access everywhere. An existing account silently falls
    // back to the OAuth-style invite (see `effectiveSignInMethod`), and the
    // caller is told via `existingAccount` so the UI can show a friendly
    // "they'll rejoin on next sign-in" note instead of the old 409.
    const existingAccount = Boolean(existingUser);
    const provisionPassword = isEmailPassword && !existingAccount;
    const effectiveSignInMethod = provisionPassword ? "email_password" : "oauth";

    // Auto-allowlist so the recipient's first sign-in passes the gate.
    // The OAuth callback consumes pending invitations on its own.
    await prisma.allowedEmail.upsert({
      where: { email },
      update: {},
      create: { email, addedBy: ctx.userId },
    });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Provision the local credential (email/password invites only) and create the
    // invitation row in ONE transaction: a failure on either side rolls both
    // back, so we never leave an orphan User (password hash, no invite) nor a
    // dangling invite. provisionEmailPasswordInvite re-checks for an existing
    // user inside the tx and throws (→ 409) if one appeared since the guard above
    // (TOCTOU-safe). The returned tempPassword is emailed only, never logged.
    let tempPassword: string | null = null;
    const invitation = await prisma.$transaction(async (tx) => {
      if (provisionPassword) {
        const provisioned = await provisionEmailPasswordInvite({
          email,
          mfaRequired: data.mfaRequired,
          client: tx,
        });
        tempPassword = provisioned.tempPassword;
      }
      return tx.invitation.create({
        data: {
          orgId,
          email,
          role: data.role,
          workRoleIds,
          expiresAt,
          // For a pre-existing account this is coerced to "oauth" (no credential
          // was provisioned) so the invariant "signInMethod === email_password ⇒
          // a temp password exists" holds and the resend flow stays consistent.
          signInMethod: effectiveSignInMethod,
          mfaRequired: data.mfaRequired,
        },
      });
    });

    const inviter = await getCurrentUser();
    const origin = getPublicOrigin(request);
    // OAuth invitees accept via a sign-in link; email/password invitees go to the
    // branded login screen and sign in with their credentials.
    const acceptUrl = provisionPassword
      ? `${origin}/login?org=${encodeURIComponent(org.slug)}`
      : `${origin}/login?invite=${invitation.token}`;
    let emailSent = false;
    let emailError: string | null = null;
    if (inviter) {
      try {
        if (provisionPassword) {
          await sendPasswordInviteEmail({
            fromUserId: ctx.userId,
            orgId,
            toEmail: email,
            orgName: org.name,
            inviterName: inviter.displayName,
            loginUrl: acceptUrl,
            tempPassword,
            mfaRequired: data.mfaRequired,
          });
        } else {
          await sendInvitationEmail({
            fromUserId: ctx.userId,
            orgId,
            toEmail: email,
            orgName: org.name,
            inviterName: inviter.displayName,
            acceptUrl,
          });
        }
        emailSent = true;
      } catch (e) {
        // Don't fail the invite creation — admin can copy the link / credential.
        emailError = e instanceof Error ? e.message : "send_failed";
      }
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "invitation.created",
      entity: "invitation",
      entityId: invitation.id,
      // NB: the temporary password is NEVER written to the audit log.
      metadata: {
        email,
        role: data.role,
        signInMethod: effectiveSignInMethod,
        existingAccount: String(existingAccount),
        mfaRequired: String(data.mfaRequired),
        emailSent: String(emailSent),
        ...(emailError ? { emailError } : {}),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // The temporary password is delivered ONLY by email (sendPasswordInviteEmail)
    // and is deliberately NOT returned here — a plaintext secret in an API
    // response leaks into proxies, server logs and browser history. If the email
    // failed (emailSent === false) the admin resends the invitation from the team
    // list; we never surface the secret.
    return created({
      invitation,
      acceptUrl,
      emailSent,
      emailError,
      // True when the invite targeted an email that already has an account: the
      // UI surfaces a "they'll rejoin on next sign-in" note instead of an error,
      // and no admin password was set on the pre-existing account.
      existingAccount,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
