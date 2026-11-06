import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext, getCurrentUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, isPermissionSubset, maskFromDb } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { SIGN_IN_METHODS } from "@/lib/auth/invite-credentials";
import { emailDomainAllowed } from "@/lib/auth/allowed-domains";
import { createOrgInvitation } from "@/lib/auth/create-invitation";
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

    const inviter = await getCurrentUser();
    // One shared path for minting an account, used by this route and by
    // approving an account request -- see createOrgInvitation for why the
    // credential rule must not be copied.
    const result = await createOrgInvitation({
      orgId,
      orgName: org.name,
      orgSlug: org.slug,
      email,
      role: data.role,
      workRoleIds,
      signInMethod: data.signInMethod,
      mfaRequired: data.mfaRequired,
      actorUserId: ctx.userId,
      // null means "no signed-in inviter", which is what suppresses the mail.
      actorDisplayName: inviter ? inviter.displayName : null,
      origin: getPublicOrigin(request),
      ipAddress: getIpAddress(request),
    });

    // The temporary password is delivered ONLY by email and is deliberately NOT
    // returned here — a plaintext secret in an API response leaks into proxies,
    // server logs and browser history. If the email failed (emailSent === false)
    // the admin resends the invitation from the team list; we never surface the
    // secret.
    return created({
      invitation: result.invitation,
      acceptUrl: result.acceptUrl,
      emailSent: result.emailSent,
      emailError: result.emailError,
      // True when the invite targeted an email that already has an account: the
      // UI surfaces a "they'll rejoin on next sign-in" note instead of an error,
      // and no admin password was set on the pre-existing account.
      existingAccount: result.existingAccount,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
