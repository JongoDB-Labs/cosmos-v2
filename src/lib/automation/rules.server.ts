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
import { cancelInputError } from "@/lib/work-items/cancel";
import { AUTOMATION_LIMITS, automationSpecSchema, type AutomationSpec } from "./spec";
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
    const statuses = await prisma.workflowStatus.findMany({ where: { projectId }, select: { key: true, category: true } });
    const keys = new Set(statuses.map((s) => s.key));
    const named: [string, string][] = [];
    if (spec.trigger.on === "item.transitioned") {
      for (const k of spec.trigger.from ?? []) named.push(["trigger.from", k]);
      for (const k of spec.trigger.to ?? []) named.push(["trigger.to", k]);
    }
    spec.actions.forEach((a, i) => a.kind === "transition" && named.push([`actions.${i}.to`, a.to]));
    for (const [path, key] of named) if (!keys.has(key)) issues.push({ path, message: `The project has no status "${key}".` });
    spec.actions.forEach((a, i) => {
      if (a.kind !== "transition" || !a.cancel || !keys.has(a.to)) return;
      if (statuses.find((s) => s.key === a.to)?.category !== "CANCELLED") issues.push({ path: `actions.${i}.cancel`, message: "A reason is only for a move to a Cancelled status." });
    });
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
    const cancelError = a.kind === "transition" && a.cancel ? cancelInputError(a.cancel.reason, a.cancel.note) : null;
    if (cancelError) issues.push({ path: `${path}.cancel`, message: cancelError });
    const text = a.kind === "addComment" ? (["comment", a.body] as const) : a.kind === "notify" ? (["notification", a.message] as const) : null;
    if (text) for (const n of unknownNames(text[1], text[0])) issues.push({ path, message: `{{${n}}} isn't a name a rule can use.` });
  }

  const cqls: [string, string][] = [];
  if (spec.condition?.cql) cqls.push(["condition.cql", spec.condition.cql]);
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

/** The fields an action can change, as an "item.updated" trigger names them; "status" for a transition. */
function changes(spec: AutomationSpec): { statuses: Set<string>; fields: Set<string> } {
  const statuses = new Set<string>();
  const fields = new Set<string>();
  for (const a of spec.actions) {
    if (a.kind === "transition") statuses.add(a.to);
    else if (a.kind === "setField") fields.add(a.field);
    else if (a.kind === "assign") fields.add("assigneeId");
    else if (a.kind === "addLabels" || a.kind === "removeLabels") fields.add("tags");
    else if (a.kind === "archive") fields.add("archivedAt");
  }
  return { statuses, fields };
}

/** Could `from`'s actions fire `to`'s trigger? Erring towards yes: this only warns. */
function canFire(from: AutomationSpec, to: AutomationSpec): boolean {
  const c = changes(from);
  const t = to.trigger;
  if (t.on === "item.transitioned") return c.statuses.size > 0 && (!t.to || t.to.some((k) => c.statuses.has(k)));
  if (t.on === "item.updated") return c.fields.size > 0 && (!t.fields || t.fields.some((f) => c.fields.has(f)));
  return false;
}

/**
 * Rules that could keep firing each other through this one: a cycle of rules
 * that each allow chains, where every rule's actions can fire the next one's
 * trigger. A warning on save (the depth limit still stops it at run time), by
 * name, in order. A rule never fires on its own changes, so it is no cycle alone.
 */
export async function chainCycle(
  orgId: string,
  projectId: string | null,
  rule: { id?: string; name: string; spec: AutomationSpec; allowChain: boolean },
): Promise<string[] | null> {
  if (!rule.allowChain) return null;
  const others = await prisma.automationRule.findMany({
    where: { orgId, enabled: true, allowChain: true, ...(rule.id && { id: { not: rule.id } }), OR: [{ projectId: null }, ...(projectId ? [{ projectId }] : [])] },
    select: { id: true, name: true, spec: true },
  });
  const nodes = [{ id: rule.id ?? "this", name: rule.name, spec: rule.spec }];
  for (const o of others) {
    const parsed = automationSpecSchema.safeParse(o.spec);
    if (parsed.success) nodes.push({ id: o.id, name: o.name, spec: parsed.data });
  }
  // Depth-first from this rule, back to it.
  const path: number[] = [0];
  const seen = new Set<number>();
  const walk = (at: number): boolean => {
    for (let next = 0; next < nodes.length; next++) {
      if (next === at || !canFire(nodes[at].spec, nodes[next].spec)) continue;
      if (next === 0) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      path.push(next);
      if (walk(next)) return true;
      path.pop();
    }
    return false;
  };
  return walk(0) ? [...path.map((i) => nodes[i].name), nodes[0].name] : null;
}

/** The warnings to show on save: today, a chain cycle. */
export async function ruleWarnings(orgId: string, projectId: string | null, rule: { id?: string; name: string; spec: unknown; allowChain: boolean }): Promise<string[]> {
  const spec = automationSpecSchema.safeParse(rule.spec);
  if (!spec.success) return [];
  const cycle = await chainCycle(orgId, projectId, { ...rule, spec: spec.data });
  return cycle ? [`These rules can keep firing each other: ${cycle.join(" → ")}. Each run stops after ${AUTOMATION_LIMITS.depth} in a row, and a rule that loops is switched off.`] : [];
}
