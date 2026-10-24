import { NextRequest } from "next/server";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { cursorPage } from "@/lib/openapi/paginate";
import { listMembers } from "./route.contract";
import { scopedRosterUserIds } from "@/lib/members/scoped-roster.server";
import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { created, handleApiError, getIpAddress } from "@/lib/api-helpers";
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
    const { ctx } = await orgContext((await params).orgId, listMembers);
    const { params: { orgId }, query } = await parseRequest(listMembers, request, params);
    const page = cursorPage<{ joinedAt: Date; id: string }>({
      request, query,
      order: [
        { field: "joinedAt", dir: "asc", type: "date" },
        { field: "id", dir: "asc", type: "string" },
      ],
    });

    // A project-scoped key sees only the people on its projects (scopes narrow).
    const roster = await scopedRosterUserIds(ctx);
    const fetched = await prisma.orgMember.findMany({
      where: { AND: [{ orgId }, page.where, ...(roster ? [{ userId: { in: roster } }] : [])] },
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
      orderBy: page.orderBy,
      take: page.take,
    });
    const { rows: members, headers } = page.finish(fetched);

    return respond(listMembers, 200, members, { headers, ctx });
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return problem(404, "not_found", undefined, { request });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return problem(401, "unauthorized", undefined, { request });
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
      return problem(409, "conflict", "User is already a member", { request });
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
    return handleApiError(error, request);
  }
}
