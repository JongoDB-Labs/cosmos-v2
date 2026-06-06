import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext, getCurrentUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { sendInvitationEmail } from "@/lib/integrations/invitation-email";
import { z } from "zod";
import { OrgRole } from "@prisma/client";

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(OrgRole).default(OrgRole.MEMBER),
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
      data: { orgId, email, role: data.role, expiresAt },
    });

    const inviter = await getCurrentUser();
    const acceptUrl = `${getPublicOrigin(request)}/login?invite=${invitation.token}`;
    let emailSent = false;
    let emailError: string | null = null;
    if (inviter) {
      try {
        await sendInvitationEmail({
          fromUserId: ctx.userId,
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
