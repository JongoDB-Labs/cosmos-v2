import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { autoJoinGeneral } from "@/lib/chat/seed-general";
import { z } from "zod";
import { OrgRole } from "@prisma/client";

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.nativeEnum(OrgRole).default(OrgRole.MEMBER),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const members = await prisma.orgMember.findMany({
      where: { orgId },
      select: {
        id: true,
        orgId: true,
        userId: true,
        role: true,
        joinedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            avatarUrl: true,
            lastActiveAt: true,
          },
        },
      },
      orderBy: { joinedAt: "asc" },
    });

    return success(members);
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
    const data = addMemberSchema.parse(body);

    const existing = await prisma.orgMember.findUnique({
      where: { orgId_userId: { orgId, userId: data.userId } },
    });
    if (existing) {
      return new Response(
        JSON.stringify({ error: "User is already a member" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    const member = await prisma.orgMember.create({
      data: {
        orgId,
        userId: data.userId,
        role: data.role,
      },
      select: {
        id: true,
        orgId: true,
        userId: true,
        role: true,
        joinedAt: true,
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            avatarUrl: true,
          },
        },
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "member.added",
      entity: "org_member",
      entityId: member.id,
      metadata: { targetUserId: data.userId, role: data.role } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    try {
      await autoJoinGeneral(
        orgId,
        member.userId,
        member.role === OrgRole.OWNER || member.role === OrgRole.ADMIN,
      );
    } catch (err) {
      console.warn("[chat] failed to auto-join new OrgMember to #general", { orgId, userId: member.userId }, err);
    }

    return created(member);
  } catch (error) {
    return handleApiError(error);
  }
}
