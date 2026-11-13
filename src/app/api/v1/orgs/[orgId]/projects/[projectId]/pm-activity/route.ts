import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { success, handleApiError } from "@/lib/api-helpers";
import { resolvePmSubject, isPmSubjectType, type PmSubjectType } from "@/lib/pm/subjects";
import { canSeeProjectMoney, projectMoneyActivity, type MoneyKind } from "@/lib/rbac/money-fields";

/** The registers whose history records changes to money fields. */
const MONEY_KIND: Partial<Record<PmSubjectType, MoneyKind>> = {
  clin: "clin",
  change: "change",
  vendor: "vendor",
};

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "ANALYTICS_READ");

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

    const rows = activities.map((a) => ({
      id: a.id,
      action: a.action,
      field: a.field,
      oldValue: a.oldValue,
      newValue: a.newValue,
      userId: a.userId,
      userName: nameById.get(a.userId) ?? null,
      createdAt: a.createdAt,
    }));
    // The history of a money field holds the figures themselves ("changed
    // Ceiling: 900,000 -> 950,000"), so it follows the same rule as the field.
    const kind = MONEY_KIND[subjectType];
    return success(kind ? projectMoneyActivity(kind, rows, await canSeeProjectMoney(ctx, projectId)) : rows);
  } catch (error) {
    return handleApiError(error);
  }
}
