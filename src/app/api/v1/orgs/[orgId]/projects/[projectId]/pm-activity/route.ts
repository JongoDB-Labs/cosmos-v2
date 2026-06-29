import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { resolvePmSubject, isPmSubjectType } from "@/lib/pm/subjects";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ANALYTICS_READ);

    const { searchParams } = new URL(request.url);
    const subjectType = searchParams.get("subjectType") ?? "";
    const subjectId = searchParams.get("subjectId") ?? "";
    if (!isPmSubjectType(subjectType) || !subjectId)
      return new Response("Bad request", { status: 400 });

    const subject = await resolvePmSubject(subjectType, subjectId, orgId, projectId);
    if (!subject) return new Response("Not found", { status: 404 });

    const activities = await prisma.activity.findMany({
      where: { orgId, subjectType, subjectId },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    const userIds = [...new Set(activities.map((a) => a.userId))];
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const nameById = new Map(users.map((u) => [u.id, u.displayName]));

    return success(
      activities.map((a) => ({
        id: a.id,
        action: a.action,
        field: a.field,
        oldValue: a.oldValue,
        newValue: a.newValue,
        userId: a.userId,
        userName: nameById.get(a.userId) ?? null,
        createdAt: a.createdAt,
      })),
    );
  } catch (error) {
    return handleApiError(error);
  }
}
