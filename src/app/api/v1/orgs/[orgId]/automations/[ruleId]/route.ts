import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, getIpAddress, success } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { parseRequest } from "@/lib/openapi/respond";
import { orgContext } from "@/lib/openapi/org-context";
import { requirePermission } from "@/lib/rbac/check";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { ruleInOrg } from "@/lib/automation/route-auth.server";
import { RULE_DTO_SELECT, ruleWarnings, updateRule } from "@/lib/automation/rules.server";
import { deleteAutomationRule, getAutomationRule, updateAutomationRule } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; ruleId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(getAutomationRule, request, params);
    const { ctx } = await orgContext(p.orgId, getAutomationRule);
    const rule = await ruleInOrg(ctx, p.ruleId);
    if (rule.projectId) await requireProjectManage(ctx, rule.projectId, Permission.AUTOMATION_MANAGE);
    else requirePermission(ctx, Permission.AUTOMATION_MANAGE);
    return success(await prisma.automationRule.findUniqueOrThrow({ where: { id: p.ruleId }, select: RULE_DTO_SELECT }));
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p, body } = await parseRequest(updateAutomationRule, request, params);
    const { ctx } = await orgContext(p.orgId, updateAutomationRule);
    const rule = await ruleInOrg(ctx, p.ruleId);
    if (rule.projectId) await requireProjectManage(ctx, rule.projectId, Permission.AUTOMATION_MANAGE);
    else requirePermission(ctx, Permission.AUTOMATION_MANAGE);
    const { revision, ...patch } = body;
    const updated = await updateRule(ctx, { id: rule.id, projectId: rule.projectId, revision }, patch);
    await logAudit({
      orgId: p.orgId,
      userId: ctx.userId,
      action: patch.enabled === false ? "automation.rule_disabled" : patch.enabled === true ? "automation.rule_enabled" : "automation.rule_updated",
      entity: "automation_rule",
      entityId: rule.id,
      metadata: { revision: updated.revision, fields: Object.keys(patch) },
      ipAddress: getIpAddress(request),
    });
    return success({ ...updated, warnings: await ruleWarnings(p.orgId, updated.projectId, updated) });
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(deleteAutomationRule, request, params);
    const { ctx } = await orgContext(p.orgId, deleteAutomationRule);
    const rule = await ruleInOrg(ctx, p.ruleId);
    if (rule.projectId) await requireProjectManage(ctx, rule.projectId, Permission.AUTOMATION_MANAGE);
    else requirePermission(ctx, Permission.AUTOMATION_MANAGE);
    await prisma.automationRule.delete({ where: { id: rule.id } });
    await logAudit({
      orgId: p.orgId,
      userId: ctx.userId,
      action: "automation.rule_deleted",
      entity: "automation_rule",
      entityId: rule.id,
      metadata: { name: rule.name, projectId: rule.projectId },
      ipAddress: getIpAddress(request),
    });
    return success({ deleted: true as const });
  } catch (error) {
    return handleApiError(error, request);
  }
}
