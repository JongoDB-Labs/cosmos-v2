/**
 * Automation rules: create, edit, list, delete (workflow P4b).
 *
 * Saving a rule makes the saver its owner and records what they can do now as
 * its cap (`actorCap`, Q7): the rule never acts beyond it. So editing a rule
 * whose owner left is how someone takes it over, and a rule switched off for
 * that reason (or for looping) is switched back on by saving it.
 *
 * A spec is checked against the org before it's stored: statuses, teams,
 * intervals, people and webhooks must be the project's or the org's, and its
 * CQL must compile for the person saving it. Callers gate who may save: the
 * routes require AUTOMATION_MANAGE, or the project's manager for a project rule.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { maskToDb } from "@/lib/rbac/permissions";
import { prepareCql } from "@/lib/query/execute.server";
import { CqlError } from "@/lib/query/errors";
import { ProblemError } from "@/lib/openapi/problem";
import { WorkflowEditError } from "@/lib/workflow/contract";
import { assignableMembersWhere } from "@/lib/work-items/apply-change.server";
import { automationSpecSchema, type AutomationSpec } from "./spec";
import { unknownNames } from "./template";

export interface RuleIssue {
  path: string;
  message: string;
}

/** What's wrong with a spec for this org and project, if anything. */
export async function ruleIssues(ctx: AuthContext, projectId: string | null, spec: AutomationSpec): Promise<RuleIssue[]> {
  const issues: RuleIssue[] = [];
  const orgId = ctx.orgId;

  if (projectId) {
    const keys = new Set((await prisma.workflowStatus.findMany({ where: { projectId }, select: { key: true } })).map((s) => s.key));
    const named: [string, string][] = [];
    if (spec.trigger.on === "item.transitioned") {
      for (const k of spec.trigger.from ?? []) named.push(["trigger.from", k]);
      for (const k of spec.trigger.to ?? []) named.push(["trigger.to", k]);
    }
    spec.actions.forEach((a, i) => a.kind === "transition" && named.push([`actions.${i}.to`, a.to]));
    for (const [path, key] of named) if (!keys.has(key)) issues.push({ path, message: `The project has no status "${key}".` });
  }

  for (const [i, a] of spec.actions.entries()) {
    const path = `actions.${i}`;
    if (a.kind === "setField" && a.field === "teamId" && a.value) {
      const ok = projectId ? await prisma.team.count({ where: { id: a.value, projectId } }) : 0;
      if (!ok) issues.push({ path, message: projectId ? "That team isn't part of this project." : "An org-wide rule can't set a team." });
    }
    if (a.kind === "setField" && a.field === "intervalId" && a.value) {
      const ok = projectId ? await prisma.interval.count({ where: { id: a.value, projectId } }) : 0;
      if (!ok) issues.push({ path, message: projectId ? "That interval isn't part of this project." : "An org-wide rule can't set an interval." });
    }
    const people = a.kind === "assign" && typeof a.to === "object" ? [a.to.userId] : a.kind === "notify" && typeof a.to === "object" ? a.to.userIds : [];
    if (people.length) {
      const found = await prisma.orgMember.count({ where: assignableMembersWhere(orgId, [...new Set(people)]) });
      if (found !== new Set(people).size) issues.push({ path, message: "Everyone named must be a member of this organization." });
    }
    if (a.kind === "webhook" && !(await prisma.webhook.count({ where: { id: a.webhookId, orgId } }))) {
      issues.push({ path, message: "That webhook doesn't exist in this organization." });
    }
    const text = a.kind === "addComment" ? (["comment", a.body] as const) : a.kind === "notify" ? (["notification", a.message] as const) : null;
    if (text) for (const n of unknownNames(text[1], text[0])) issues.push({ path, message: `{{${n}}} isn't a name a rule can use.` });
  }

  const cqls: [string, string][] = [];
  if (spec.condition) cqls.push(["condition.cql", spec.condition.cql]);
  if (spec.trigger.on === "schedule") cqls.push(["trigger.cql", spec.trigger.cql]);
  for (const [path, cql] of cqls) {
    try {
      await prepareCql(ctx, { cql }, { contextProjectId: projectId ?? undefined });
    } catch (e) {
      if (!(e instanceof CqlError)) throw e;
      issues.push({ path, message: e.diagnostics[0]?.message ?? "The query isn't valid." });
    }
  }
  return issues;
}

function invalid(issues: RuleIssue[]): never {
  throw new WorkflowEditError("automation_invalid", issues[0].message, { issues });
}

export const RULE_DTO_SELECT = {
  id: true, projectId: true, name: true, enabled: true, spec: true, revision: true, ownerId: true, allowChain: true, templateKey: true,
  disabledReason: true, createdAt: true, updatedAt: true,
} as const satisfies Prisma.AutomationRuleSelect;

export async function createRule(
  ctx: AuthContext,
  input: { projectId: string | null; name: string; spec: unknown; enabled?: boolean; allowChain?: boolean; templateKey?: string | null },
) {
  const spec = automationSpecSchema.parse(input.spec);
  const issues = await ruleIssues(ctx, input.projectId, spec);
  if (issues.length) invalid(issues);
  return prisma.automationRule.create({
    data: {
      orgId: ctx.orgId,
      projectId: input.projectId,
      name: input.name,
      enabled: input.enabled ?? true,
      spec: spec as unknown as Prisma.InputJsonValue,
      actorCap: maskToDb(ctx.permissions),
      ownerId: ctx.userId,
      allowChain: input.allowChain ?? false,
      templateKey: input.templateKey ?? null,
    },
    select: RULE_DTO_SELECT,
  });
}

/** Edit a rule. The editor becomes its owner and its cap is theirs (Q7). */
export async function updateRule(
  ctx: AuthContext,
  rule: { id: string; projectId: string | null; revision: number },
  patch: { name?: string; spec?: unknown; enabled?: boolean; allowChain?: boolean },
) {
  let spec: AutomationSpec | undefined;
  if (patch.spec !== undefined) {
    spec = automationSpecSchema.parse(patch.spec);
    const issues = await ruleIssues(ctx, rule.projectId, spec);
    if (issues.length) invalid(issues);
  }
  // On the revision read, so two people saving at once don't both win.
  const updated = await prisma.automationRule.updateMany({
    where: { id: rule.id, orgId: ctx.orgId, revision: rule.revision },
    data: {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(spec && { spec: spec as unknown as Prisma.InputJsonValue }),
      ...(patch.allowChain !== undefined && { allowChain: patch.allowChain }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      // Saving answers whatever switched it off; switching it off by hand says nothing.
      disabledReason: null,
      revision: { increment: 1 },
      actorCap: maskToDb(ctx.permissions),
      ownerId: ctx.userId,
    },
  });
  if (updated.count === 0) throw new ProblemError(409, "conflict", "Someone else changed this rule. Reload it and try again.");
  return prisma.automationRule.findUniqueOrThrow({ where: { id: rule.id }, select: RULE_DTO_SELECT });
}
