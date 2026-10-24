/**
 * The not-found half of an automation route's checks: the rule (or project)
 * is the caller's org's, or a 404. Each handler then gates on its own bit, in
 * its own body, where the scope tests read it: AUTOMATION_MANAGE for an
 * org-wide rule; for a project's, that bit or the project's manager
 * (requireProjectManage, which a key's role never counts as). No API-key
 * scope carries AUTOMATION_MANAGE, so in practice a person does this.
 */
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { ProblemError } from "@/lib/openapi/problem";

export async function ruleInOrg(ctx: AuthContext, ruleId: string) {
  const rule = await prisma.automationRule.findFirst({ where: { id: ruleId, orgId: ctx.orgId }, select: { id: true, projectId: true, revision: true, name: true } });
  if (!rule) throw new ProblemError(404, "not_found", "Automation rule not found");
  return rule;
}

export async function projectInOrg(ctx: AuthContext, projectId: string | null): Promise<void> {
  if (!projectId) return;
  const project = await prisma.project.findFirst({ where: { id: projectId, orgId: ctx.orgId }, select: { id: true } });
  if (!project) throw new ProblemError(404, "not_found", "Project not found");
}
