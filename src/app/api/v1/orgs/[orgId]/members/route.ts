import { NextRequest } from "next/server";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { cursorPage } from "@/lib/openapi/paginate";
import { listMembers } from "./route.contract";
import { scopedRosterUserIds } from "@/lib/members/scoped-roster.server";
import { prisma } from "@/lib/db/client";
import { avatarSrc } from "@/lib/users/avatar-url.server";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { assertCanGrantOrgRole, heldBeyondRole } from "@/lib/rbac/grant-ceiling";
import { created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { addOrReinstateMember, membershipRow } from "@/lib/members/add-member.server";
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
    // Avatars are stored as `data:` URIs. Sent inline, three of them were 93%
    // of this response and base64 does not compress, so `encode` could not
    // claw it back. Point at the avatar endpoint, which serves them once.
    const withAvatars = members.map((m) => ({
      ...m,
      user: { ...m.user, avatarUrl: avatarSrc(orgId, m.user.id, m.user.avatarUrl) },
    }));

    return respond(listMembers, 200, withAvatars, { headers, ctx });
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

    // Their row, removed or not: re-adding someone who was removed reinstates
    // it rather than starting a new one (addOrReinstateMember says why).
    const existing = await membershipRow(orgId, data.userId);
    if (existing && existing.removedAt === null) {
      return problem(409, "conflict", "User is already a member", { request });
    }

    // The caller may only hand out what they hold themselves (and OWNER only if
    // they are one). Reinstating brings the member's stored override and work
    // roles back with them, so those count as granted too.
    assertCanGrantOrgRole(ctx, data.role, existing ? heldBeyondRole(existing) : 0n);

    const joined = await addOrReinstateMember({
      orgId,
      userId: data.userId,
      role: data.role,
      existing,
      actorUserId: ctx.userId,
      ipAddress: getIpAddress(request),
    });
    if (!joined) return problem(409, "conflict", "User is already a member", { request });

    return created(joined.member);
  } catch (error) {
    return handleApiError(error, request);
  }
}
