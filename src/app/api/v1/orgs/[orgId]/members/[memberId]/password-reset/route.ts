import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { createPasswordResetToken } from "@/lib/auth/password-reset";
import { sendPasswordResetEmail } from "@/lib/integrations/invitation-email";

type RouteParams = { params: Promise<{ orgId: string; memberId: string }> };

/**
 * Admin/owner-triggered password reset for an org member.
 *
 * Sends the same self-service reset email (signed, single-use, time-limited link)
 * to the member — but only for an email/password account. A Google/SSO-only member
 * (no passwordHash) has nothing to reset, so we return `{ sent: false, reason:
 * "sso" }` and the UI shows a clear message. Requires ORG_MANAGE_MEMBERS.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, memberId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const member = await prisma.orgMember.findUnique({
      where: { id: memberId },
      select: {
        orgId: true,
        user: {
          select: {
            id: true,
            email: true,
            passwordHash: true,
            passwordSetAt: true,
            deactivatedAt: true,
            isBot: true,
          },
        },
      },
    });
    if (!member || member.orgId !== orgId) {
      return new Response("Not found", { status: 404 });
    }

    const user = member.user;

    // Google/SSO-only (or a deactivated/bot) account: nothing to reset.
    if (!user.passwordHash || user.deactivatedAt || user.isBot) {
      return success({
        sent: false,
        reason: "sso",
        message:
          "This member signs in with Google/SSO and has no password to reset.",
      });
    }

    const token = createPasswordResetToken({
      id: user.id,
      passwordHash: user.passwordHash,
      passwordSetAt: user.passwordSetAt,
    });
    const resetUrl = `${getPublicOrigin(request)}/reset-password?token=${encodeURIComponent(token)}`;

    let sent = false;
    let emailError: string | null = null;
    try {
      await sendPasswordResetEmail({
        orgId,
        toEmail: user.email,
        resetUrl,
      });
      sent = true;
    } catch (e) {
      emailError = e instanceof Error ? e.message : "send_failed";
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "member.password_reset_sent",
      entity: "user",
      entityId: user.id,
      metadata: {
        email: user.email,
        emailSent: String(sent),
        ...(emailError ? { emailError } : {}),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ sent, emailError });
  } catch (error) {
    return handleApiError(error);
  }
}
