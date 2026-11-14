import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { HELD_WORK_ROLES, OWNER_CHANGE_MESSAGE, currentAccessRefusal, heldBeyondRole } from "@/lib/rbac/grant-ceiling";
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
 * "sso" }` and the UI shows a clear message. Requires ORG_MANAGE_MEMBERS, and
 * the same ceiling as changing or removing the member: it acts on their account,
 * so the caller may send one only to someone whose current access they could
 * have granted.
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
        role: true,
        permissions: true,
        workRoles: HELD_WORK_ROLES,
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
    // The ceiling on current role, as in the member PUT and DELETE: without it a
    // member who manages members through a work role could send password resets
    // to admins and owners. See grant-ceiling.ts.
    const current = currentAccessRefusal(ctx, member.role, heldBeyondRole(member));
    if (current) {
      // The team table shows this as it stands, so it names a reset, not a change.
      const error =
        current === OWNER_CHANGE_MESSAGE
          ? "Only an owner can send a password reset to an owner."
          : "You can't send a password reset to someone whose access is beyond your own.";
      return new Response(JSON.stringify({ error }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
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
