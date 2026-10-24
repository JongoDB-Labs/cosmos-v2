import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, success } from "@/lib/api-helpers";
import { parseRequest } from "@/lib/openapi/respond";
import { orgContext } from "@/lib/openapi/org-context";
import { requirePermission } from "@/lib/rbac/check";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { ruleInOrg } from "@/lib/automation/route-auth.server";
import { listAutomationRuns } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; ruleId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p, query } = await parseRequest(listAutomationRuns, request, params);
    const { ctx } = await orgContext(p.orgId, listAutomationRuns);
    const rule = await ruleInOrg(ctx, p.ruleId);
    if (rule.projectId) await requireProjectManage(ctx, rule.projectId, Permission.AUTOMATION_MANAGE);
    else requirePermission(ctx, Permission.AUTOMATION_MANAGE);
    const runs = await prisma.automationRun.findMany({
      where: { ruleId: p.ruleId, ...(query.before && { createdAt: { lt: new Date(query.before) } }) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: query.limit ?? 50,
      select: { id: true, ruleRevision: true, eventId: true, correlationId: true, depth: true, status: true, itemsMatched: true, actions: true, durationMs: true, createdAt: true },
    });
    return success(runs.map((r) => ({ ...r, eventId: r.eventId?.toString() ?? null })));
  } catch (error) {
    return handleApiError(error, request);
  }
}
