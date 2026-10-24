import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, getIpAddress, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest } from "@/lib/openapi/respond";
import { orgContext } from "@/lib/openapi/org-context";
import { requirePermission } from "@/lib/rbac/check";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectVisible } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { projectInOrg } from "@/lib/automation/route-auth.server";
import { createRule, RULE_DTO_SELECT, ruleWarnings } from "@/lib/automation/rules.server";
import { createAutomationRule, listAutomationRules } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p, query } = await parseRequest(listAutomationRules, request, params);
    const { ctx } = await orgContext(p.orgId, listAutomationRules);
    await projectInOrg(ctx, query.projectId ?? null);
    // A team-scoped project is its team's and the org admins' alone, whatever bit the caller holds.
    if (query.projectId) await requireProjectVisible(ctx, query.projectId);
    if (query.projectId) await requireProjectManage(ctx, query.projectId, Permission.AUTOMATION_MANAGE);
    else requirePermission(ctx, Permission.AUTOMATION_MANAGE);
    const rules = await prisma.automationRule.findMany({
      where: { orgId: p.orgId, projectId: query.projectId ?? null },
      select: RULE_DTO_SELECT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return success(rules);
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p, body } = await parseRequest(createAutomationRule, request, params);
    const { ctx } = await orgContext(p.orgId, createAutomationRule);
    await projectInOrg(ctx, body.projectId);
    if (body.projectId) await requireProjectVisible(ctx, body.projectId);
    if (body.projectId) await requireProjectManage(ctx, body.projectId, Permission.AUTOMATION_MANAGE);
    else requirePermission(ctx, Permission.AUTOMATION_MANAGE);
    const rule = await createRule(ctx, body);
    await logAudit({
      orgId: p.orgId,
      userId: ctx.userId,
      action: "automation.rule_created",
      entity: "automation_rule",
      entityId: rule.id,
      metadata: { projectId: rule.projectId, name: rule.name, trigger: (rule.spec as { trigger: { on: string } }).trigger.on },
      ipAddress: getIpAddress(request),
    });
    return success({ ...rule, warnings: await ruleWarnings(p.orgId, rule.projectId, rule) }, 201);
  } catch (error) {
    return handleApiError(error, request);
  }
}
