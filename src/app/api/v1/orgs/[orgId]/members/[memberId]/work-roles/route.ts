import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission, isPermissionSubset, maskFromDb } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; memberId: string }> };

const setSchema = z.object({
  workRoleIds: z.array(z.string().uuid()).max(200),
});

/**
 * Per-member mirror of PUT .../work-roles/[roleId]/members (which sets the
 * member list for ONE role). This sets the ROLE list for one member: SET
 * semantics with delta guarding — only newly ADDED roles are ceiling-checked
 * against the caller's own `basePermissions` (mirrors the escalation guard at
 * work-roles/[roleId]/members/route.ts:49-63), so a caller can't grant a role
 * that exceeds what they themselves hold. Removals (de-escalation) are always
 * allowed, unchecked. All ceiling/existence checks run BEFORE the single
 * `$transaction`, so a violation never leaves a partial write.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, memberId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_MEMBERS);

    const member = await prisma.orgMember.findUnique({
      where: { id: memberId },
      select: { id: true, orgId: true },
    });
    if (!member || member.orgId !== orgId) {
      return new Response("Not found", { status: 404 });
    }

    const { workRoleIds } = setSchema.parse(await request.json());
    const requestedIds = [...new Set(workRoleIds)];
    const requestedSet = new Set(requestedIds);

    const current = await prisma.orgMemberWorkRole.findMany({
      where: { orgMemberId: memberId },
      select: { workRoleId: true },
    });
    const currentIds = new Set(current.map((r) => r.workRoleId));

    const additions = requestedIds.filter((id) => !currentIds.has(id));
    const removals = [...currentIds].filter((id) => !requestedSet.has(id));

    // Every ADDITION must resolve to a real role in THIS org, and must not
    // grant anything beyond the caller's own basePermissions. Both checks run
    // for every addition before any write, so a single bad id — unknown or
    // over-ceiling — aborts the whole request with no partial write.
    if (additions.length > 0) {
      const roles = await prisma.workRole.findMany({ where: { id: { in: additions }, orgId } });
      const roleById = new Map(roles.map((r) => [r.id, r]));

      for (const id of additions) {
        const role = roleById.get(id);
        if (!role) {
          return new Response(JSON.stringify({ error: "unknown work role" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (!isPermissionSubset(maskFromDb(role.grants), ctx.basePermissions)) {
          return new Response(
            JSON.stringify({
              error: `You can't grant '${role.name}' — it exceeds your own permissions`,
            }),
            { status: 403, headers: { "Content-Type": "application/json" } },
          );
        }
      }
    }

    await prisma.$transaction([
      prisma.orgMemberWorkRole.deleteMany({
        where: { orgMemberId: memberId, workRoleId: { in: removals } },
      }),
      prisma.orgMemberWorkRole.createMany({
        data: additions.map((id) => ({ orgMemberId: memberId, workRoleId: id })),
        skipDuplicates: true,
      }),
    ]);

    await logAudit({
      orgId,
      userId: ctx.userId,
      // Distinct from the per-role route's "work_role.members_set" so audit
      // queries can tell "one member's set changed" from "one role's roster changed".
      action: "member.work_roles_set",
      entity: "org_member",
      entityId: memberId,
      metadata: {
        memberId,
        added: String(additions.length),
        removed: String(removals.length),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({ workRoleIds: requestedIds });
  } catch (error) {
    return handleApiError(error);
  }
}
