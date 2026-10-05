import { NextRequest } from "next/server";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
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

    // Unfiltered on purpose: a previously-removed person still HAS a row (soft
    // delete), and `@@unique([orgId, userId])` means creating a second one fails. The
    // default-filtered client would report them absent and send us straight into that
    // constraint violation, so membership lifecycle reads the real state.
    const existing = await prismaUnfiltered.orgMember.findUnique({
      where: { orgId_userId: { orgId, userId: data.userId } },
      select: { id: true, removedAt: true },
    });
    if (existing && existing.removedAt === null) {
      return new Response(
        JSON.stringify({ error: "User is already a member" }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    const memberSelect = {
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
    } as const;

    // Re-adding someone who was removed REINSTATES their original row rather than
    // starting a new one. Their retained project memberships and work roles therefore
    // come back with them, which is what the common case — a removal being undone —
    // calls for, and what keeps their history on one membership id. The role is taken
    // from this request, so reinstating is never a silent re-grant of the old one.
    const member = existing
      ? await prismaUnfiltered.orgMember.update({
          where: { id: existing.id },
          data: { removedAt: null, role: data.role },
          select: memberSelect,
        })
      : await prisma.orgMember.create({
          data: {
            orgId,
            userId: data.userId,
            role: data.role,
          },
          select: memberSelect,
        });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: existing ? "member.reinstated" : "member.added",
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
