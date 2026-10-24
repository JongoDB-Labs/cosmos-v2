/**
 * The automation rule engine (workflow design §5.4, as approved in P4).
 *
 * For each outbox event, every enabled rule of its project (then the org's
 * own rules) whose trigger matches is run once:
 *
 *   - A rule never fires on its own changes (`causedByRuleId`), and an
 *     automation's change fires another rule only if that rule allows chains.
 *   - A chain deeper than AUTOMATION_LIMITS.depth is a LOOP; a rule that loops
 *     three times in an hour, or runs more than RULE_RUNS_PER_5_MIN times in
 *     five minutes, is switched off and its owner told.
 *   - An org runs at most ORG_RUNS_PER_HOUR rules an hour; past that a run is
 *     THROTTLED (recorded, not retried).
 *   - The rule runs as its owner, loaded fresh, capped at the save-time mask
 *     (principal.server.ts). An owner who can no longer act switches it off.
 *   - The run row is claimed (unique rule_id + event_id) BEFORE any action
 *     runs, so a worker that crashes and redoes the event never repeats a
 *     rule's comment or notification: at most once, never twice.
 *
 * Every run is an automation_runs row; every run that did something or was
 * stopped is also an audit entry (NO_MATCH and SKIPPED_SELF, by far the
 * commonest and where nothing happened, are the run row only).
 */
import { randomUUID } from "crypto";
import { Prisma, type AutomationRunStatus, type ColumnCategory } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";
import { recordAutomationRun } from "@/lib/observability/metrics";
import { createNotification } from "@/lib/notifications/create";
import { matchingItemIds } from "@/lib/query/execute.server";
import { AUTOMATION_LIMITS, automationSpecSchema, type AutomationSpec } from "./spec";
import { scheduleDue, triggerMatches } from "./trigger";
import { automationUserId, ruleContext } from "./principal.server";
import { runActions, type ActionOutcome } from "./actions.server";

export const RULE_RUNS_PER_5_MIN = 200;
export const ORG_RUNS_PER_HOUR = 5_000;
const LOOPS_BEFORE_DISABLE = 3;

export interface RuleEvent {
  id: bigint;
  orgId: string;
  projectId: string | null;
  type: string;
  subjectId: string;
  payload: Prisma.JsonObject;
  actorId: string | null;
  source: string;
  correlationId: string;
  depth: number;
  causedByRuleId: string | null;
  fromCategory?: string | null;
  toCategory?: string | null;
}

type Rule = { id: string; orgId: string; projectId: string | null; name: string; spec: Prisma.JsonValue; revision: number; actorCap: string; ownerId: string | null; allowChain: boolean };

const RULE_SELECT = { id: true, orgId: true, projectId: true, name: true, spec: true, revision: true, actorCap: true, ownerId: true, allowChain: true } as const;

/** Run the rules every event fires. Returns how many runs were recorded. */
export async function runRulesForEvents(events: readonly RuleEvent[], opts: { now?: () => Date } = {}): Promise<number> {
  const now = opts.now ?? (() => new Date());
  const rulesByOrg = new Map<string, Rule[]>();
  let runs = 0;
  for (const e of events) {
    if (e.source === "MIGRATION") continue;
    if (!rulesByOrg.has(e.orgId)) {
      rulesByOrg.set(
        e.orgId,
        await prisma.automationRule.findMany({ where: { orgId: e.orgId, enabled: true }, select: RULE_SELECT, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
      );
    }
    // The project's own rules first, then the org's.
    const rules = rulesByOrg.get(e.orgId)!.filter((r) => r.projectId === e.projectId || r.projectId === null);
    rules.sort((a, b) => Number(a.projectId === null) - Number(b.projectId === null));
    for (const rule of rules) {
      const spec = automationSpecSchema.safeParse(rule.spec);
      if (!spec.success || !triggerMatches(spec.data.trigger, e)) continue;
      if (e.source === "IMPORT" && !spec.data.options.includeImports) continue;
      if (e.source === "AUTOMATION" && e.causedByRuleId !== rule.id && !rule.allowChain) continue;
      if (await runForEvent(rule, spec.data, e, now)) runs++;
    }
  }
  return runs;
}

/** Returns false when the rule had already run for this event. */
async function runForEvent(rule: Rule, spec: AutomationSpec, e: RuleEvent, now: () => Date): Promise<boolean> {
  const started = Date.now();
  const runId = await claimRun(rule, e.id, e.correlationId, e.depth + 1);
  if (!runId) return false;
  const finish = (status: AutomationRunStatus, extra: { itemsMatched?: number; actions?: ActionOutcome[]; note?: string } = {}) =>
    finishRun(rule, runId, status, started, { ...extra, eventId: e.id, subjectId: e.subjectId });

  if (e.causedByRuleId === rule.id) {
    await finish("SKIPPED_SELF");
    return true;
  }
  if (e.depth + 1 > AUTOMATION_LIMITS.depth) {
    await finish("LOOP", { note: `Chain deeper than ${AUTOMATION_LIMITS.depth} automations.` });
    const loops = await prisma.automationRun.count({ where: { ruleId: rule.id, status: "LOOP", createdAt: { gte: new Date(now().getTime() - 3_600_000) } } });
    if (loops >= LOOPS_BEFORE_DISABLE) await disable(rule, `It looped ${loops} times in an hour: its changes keep firing automations.`);
    return true;
  }
  const guard = await overBudget(rule, now());
  if (guard) {
    await finish("THROTTLED", { note: guard.reason });
    if (guard.disable) await disable(rule, guard.reason);
    return true;
  }
  const ctx = await ruleContext(rule);
  if (!ctx) {
    await finish("FAILED", { note: "Its owner can no longer act for it." });
    await disable(rule, "Its owner is no longer a member. Save the rule to take it over.");
    return true;
  }

  try {
    const scope = await scopeIds(e.subjectId, spec.scope);
    const cql = spec.condition?.cql;
    const queried = cql ? await matchingItemIds(ctx, { cql }, { within: scope, now: now(), contextProjectId: rule.projectId ?? undefined }) : scope;
    const childrenAll = spec.condition?.childrenAll;
    const matched = childrenAll ? await childrenAllIn(queried, childrenAll.categories) : queried;
    if (matched.length === 0) {
      await finish("NO_MATCH");
      return true;
    }
    const run = {
      rule: { id: rule.id, name: rule.name, orgId: rule.orgId },
      ctx,
      automationUserId: await automationUserId(rule.orgId),
      triggerActorId: e.actorId,
      correlationId: e.correlationId,
      depth: e.depth + 1,
      now: now(),
    };
    const outcomes: ActionOutcome[] = [];
    for (const id of matched) outcomes.push(...(await runActions(run, id, spec.actions)));
    await finish(statusOf(outcomes), { itemsMatched: matched.length, actions: outcomes });
  } catch (err) {
    await finish("FAILED", { note: (err instanceof Error ? err.message : "Unknown error").slice(0, 300) });
  }
  return true;
}

/**
 * Run every scheduled rule that is due. Called by the automation-schedules job
 * every minute and by the tick endpoint; the job runner keeps one leader, so a
 * rule's runs never overlap.
 */
export async function runDueSchedules(opts: { now?: () => Date; orgId?: string } = {}): Promise<number> {
  const now = opts.now ?? (() => new Date());
  const rules = await prisma.automationRule.findMany({
    where: { enabled: true, ...(opts.orgId && { orgId: opts.orgId }), spec: { path: ["trigger", "on"], equals: "schedule" } },
    select: RULE_SELECT,
  });
  let runs = 0;
  for (const rule of rules) {
    const spec = automationSpecSchema.safeParse(rule.spec);
    if (!spec.success || spec.data.trigger.on !== "schedule") continue;
    const last = await prisma.automationRun.findFirst({ where: { ruleId: rule.id, eventId: null }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    if (!scheduleDue(spec.data.trigger, now(), last?.createdAt ?? null)) continue;
    await runScheduled(rule, spec.data, spec.data.trigger.cql, now);
    runs++;
  }
  return runs;
}

async function runScheduled(rule: Rule, spec: AutomationSpec, cql: string, now: () => Date) {
  const started = Date.now();
  const correlationId = randomUUID();
  const runId = await claimRun(rule, null, correlationId, 1);
  if (!runId) return;
  const finish = (status: AutomationRunStatus, extra: { itemsMatched?: number; actions?: ActionOutcome[]; note?: string } = {}) =>
    finishRun(rule, runId, status, started, extra);
  const guard = await overBudget(rule, now());
  if (guard) return void (await finish("THROTTLED", { note: guard.reason }));
  const ctx = await ruleContext(rule);
  if (!ctx) {
    await finish("FAILED", { note: "Its owner can no longer act for it." });
    return void (await disable(rule, "Its owner is no longer a member. Save the rule to take it over."));
  }
  try {
    // A project rule acts on its own project's items only, whatever its query
    // says: narrowed inside the scope envelope, so the limit counts only them.
    // Its project is also the query's context, as when the rule was saved.
    const scoped = await matchingItemIds(ctx, { cql }, {
      limit: AUTOMATION_LIMITS.scheduledItems,
      now: now(),
      timeoutMs: 10_000,
      ...(rule.projectId ? { projectIds: [rule.projectId], contextProjectId: rule.projectId } : {}),
    });
    if (scoped.length === 0) return void (await finish("NO_MATCH"));
    const run = { rule: { id: rule.id, name: rule.name, orgId: rule.orgId }, ctx, automationUserId: await automationUserId(rule.orgId), triggerActorId: null, correlationId, depth: 1, now: now() };
    const outcomes: ActionOutcome[] = [];
    for (const id of scoped) outcomes.push(...(await runActions(run, id, spec.actions)));
    await finish(statusOf(outcomes), { itemsMatched: scoped.length, actions: outcomes });
  } catch (err) {
    await finish("FAILED", { note: (err instanceof Error ? err.message : "Unknown error").slice(0, 300) });
  }
}

function statusOf(outcomes: readonly ActionOutcome[]): AutomationRunStatus {
  const ok = outcomes.filter((o) => o.ok).length;
  return ok === outcomes.length ? "SUCCESS" : ok === 0 ? "FAILED" : "PARTIAL";
}

/** Insert the run row first: its unique key is what keeps a redone event from running the rule twice. */
async function claimRun(rule: Rule, eventId: bigint | null, correlationId: string, depth: number): Promise<string | null> {
  const id = randomUUID();
  const inserted = await prisma.$executeRaw`
    INSERT INTO automation_runs (id, org_id, rule_id, rule_revision, event_id, correlation_id, depth, status, duration_ms)
    VALUES (${id}::uuid, ${rule.orgId}::uuid, ${rule.id}::uuid, ${rule.revision}, ${eventId}, ${correlationId}::uuid, ${depth}, 'FAILED', 0)
    ON CONFLICT (rule_id, event_id) DO NOTHING
  `;
  return inserted === 1 ? id : null;
}

async function finishRun(
  rule: Rule,
  runId: string,
  status: AutomationRunStatus,
  started: number,
  extra: { itemsMatched?: number; actions?: ActionOutcome[]; note?: string; eventId?: bigint; subjectId?: string },
) {
  const actions = extra.actions ?? (extra.note ? [{ note: extra.note }] : []);
  await prisma.automationRun.update({
    where: { id: runId },
    data: { status, itemsMatched: extra.itemsMatched ?? 0, actions: actions as unknown as Prisma.InputJsonValue, durationMs: Date.now() - started },
  });
  recordAutomationRun(status);
  // The commonest outcomes, and nothing happened: the run row is enough.
  if (status === "NO_MATCH" || status === "SKIPPED_SELF") return;
  await logAudit({
    orgId: rule.orgId,
    action: "automation.rule_ran",
    entity: "automation_rule",
    entityId: rule.id,
    metadata: {
      runId,
      status,
      revision: rule.revision,
      ...(extra.eventId !== undefined && { eventId: extra.eventId.toString() }),
      ...(extra.subjectId && { workItemId: extra.subjectId }),
      itemsMatched: extra.itemsMatched ?? 0,
      failed: (extra.actions ?? []).filter((a) => !a.ok).length,
      ...(extra.note && { note: extra.note }),
    },
  });
}

async function overBudget(rule: Rule, now: Date): Promise<{ reason: string; disable: boolean } | null> {
  const recent = await prisma.automationRun.count({ where: { ruleId: rule.id, createdAt: { gte: new Date(now.getTime() - 5 * 60_000) } } });
  // The claimed row for this run is one of them.
  if (recent > RULE_RUNS_PER_5_MIN) return { reason: `It ran more than ${RULE_RUNS_PER_5_MIN} times in five minutes.`, disable: true };
  const org = await prisma.automationRun.count({ where: { orgId: rule.orgId, createdAt: { gte: new Date(now.getTime() - 3_600_000) } } });
  if (org > ORG_RUNS_PER_HOUR) return { reason: `The organization ran more than ${ORG_RUNS_PER_HOUR} automations this hour.`, disable: false };
  return null;
}

async function scopeIds(subjectId: string, scope: AutomationSpec["scope"]): Promise<string[]> {
  if (scope === "trigger") return [subjectId];
  if (scope === "parent") {
    const item = await prisma.workItem.findUnique({ where: { id: subjectId }, select: { parentId: true } });
    return item?.parentId ? [item.parentId] : [];
  }
  const children = await prisma.workItem.findMany({ where: { parentId: subjectId }, select: { id: true }, orderBy: { id: "asc" }, take: AUTOMATION_LIMITS.scopedItems });
  return children.map((c) => c.id);
}

/** The items, of `ids`, with at least one child and every child (archived ones aside) in one of `categories`. */
async function childrenAllIn(ids: string[], categories: readonly ColumnCategory[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const children = await prisma.workItem.findMany({
    where: { parentId: { in: ids }, archivedAt: null },
    select: { parentId: true, status: { select: { category: true } } },
  });
  const ok = new Map<string, boolean>();
  for (const c of children) ok.set(c.parentId!, (ok.get(c.parentId!) ?? true) && categories.includes(c.status.category));
  return ids.filter((id) => ok.get(id) === true);
}

async function disable(rule: Rule, reason: string) {
  const updated = await prisma.automationRule.updateMany({ where: { id: rule.id, enabled: true }, data: { enabled: false, disabledReason: reason } });
  if (updated.count === 0) return;
  await logAudit({ orgId: rule.orgId, action: "automation.rule_disabled", entity: "automation_rule", entityId: rule.id, metadata: { reason } });
  if (rule.ownerId) {
    await createNotification({
      orgId: rule.orgId,
      userId: rule.ownerId,
      type: "automation.disabled",
      title: `Automation "${rule.name}" was switched off`,
      message: reason,
      relatedType: "automation_rule",
      relatedId: rule.id,
    }).catch(() => undefined);
  }
}
