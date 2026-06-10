import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext, getCurrentUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { sendInvitationEmail } from "@/lib/integrations/invitation-email";

/**
 * Revoke (DELETE) or resend (POST) a pending invitation — the lifecycle the
 * invitations collection lacked (a sent invite could only lapse after 7 days).
 * Both gate on ORG_MANAGE_MEMBERS, the same as creating one.
 */

type RouteParams = { params: Promise<{ orgId: string; invitationId: string }> };

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invitationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const existing = await prisma.invitation.findFirst({
      where: { id: invitationId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.invitation.delete({ where: { id: invitationId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "invitation.revoked",
      entity: "invitation",
      entityId: invitationId,
      metadata: { email: existing.email } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invitationId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const existing = await prisma.invitation.findFirst({
      where: { id: invitationId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resend = refresh the 7-day window + re-send the email (same token).
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);
    const invitation = await prisma.invitation.update({
      where: { id: invitationId },
      data: { expiresAt },
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
          toEmail: invitation.email,
          orgName: org.name,
          inviterName: inviter.displayName,
          acceptUrl,
        });
        emailSent = true;
      } catch (e) {
        emailError = e instanceof Error ? e.message : "send_failed";
      }
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "invitation.resent",
      entity: "invitation",
      entityId: invitationId,
      metadata: {
        email: invitation.email,
        emailSent: String(emailSent),
        ...(emailError ? { emailError } : {}),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ invitation, acceptUrl, emailSent, emailError });
  } catch (error) {
    return handleApiError(error);
  }
}
