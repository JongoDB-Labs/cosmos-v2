import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext, getCurrentUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, isPermissionSubset } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { sendInvitationEmail } from "@/lib/integrations/invitation-email";
import { emailDomainAllowed } from "@/lib/auth/allowed-domains";
import { z } from "zod";
import { OrgRole } from "@prisma/client";

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(OrgRole).default(OrgRole.MEMBER),
  // Optional work-roles to assign on acceptance (granular permission grants +
  // ABAC policies). Validated against the inviter's ceiling below.
  workRoleIds: z.array(z.string().uuid()).max(50).default([]),
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
        (r) => !isPermissionSubset(r.grants ?? 0n, ctx.basePermissions),
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

    const existingUser = await prisma.user.findFirst({ where: { email } });
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

    // Auto-allowlist so the recipient's first sign-in passes the gate.
    // The OAuth callback consumes pending invitations on its own.
    await prisma.allowedEmail.upsert({
      where: { email },
      update: {},
      create: { email, addedBy: ctx.userId },
    });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const invitation = await prisma.invitation.create({
      data: { orgId, email, role: data.role, workRoleIds, expiresAt },
    });

    const inviter = await getCurrentUser();
    const acceptUrl = `${getPublicOrigin(request)}/login?invite=${invitation.token}`;
    let emailSent = false;
    let emailError: string | null = null;
    if (inviter) {
      try {
        await sendInvitationEmail({
          fromUserId: ctx.userId,
          orgId,
          toEmail: email,
          orgName: org.name,
          inviterName: inviter.displayName,
          acceptUrl,
        });
        emailSent = true;
      } catch (e) {
        // Don't fail the invite creation — admin can copy the link manually.
        emailError = e instanceof Error ? e.message : "send_failed";
      }
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "invitation.created",
      entity: "invitation",
      entityId: invitation.id,
      metadata: {
        email,
        role: data.role,
        emailSent: String(emailSent),
        ...(emailError ? { emailError } : {}),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created({ invitation, acceptUrl, emailSent, emailError });
  } catch (error) {
    return handleApiError(error);
  }
}
