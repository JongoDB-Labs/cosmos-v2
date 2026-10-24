/**
 * Run a rule's actions on one item. Each action is its own transaction
 * through the same writer and the same checks as a person's edit (the item
 * PUT route's order: project, then requireAccess, then the change service with
 * the workflow), under the rule's capped context (principal.server.ts). One
 * action failing doesn't undo or stop the others; the run is then PARTIAL.
 *
 * The change log names the org's automation user, and every write carries the
 * chain (depth, rule id), so the outbox worker can keep the rule from firing
 * on its own change and stop a chain that runs too deep.
 */
import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { isProjectVisible } from "@/lib/rbac/project-access";
import { loadMemberAuthContext } from "@/lib/rbac/effective-permissions";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { applyWorkItemChange, type WorkItemPatch } from "@/lib/work-items/apply-change.server";
import { loadStatusCategories } from "@/lib/boards/status-categories.server";
import { runAfterCommit } from "@/lib/work-items/after-commit";
import { setWorkItemLabels } from "@/lib/work-items/labels";
import type { WriteMeta } from "@/lib/work-items/events.server";
import { teamProjectError } from "@/lib/teams/item-team.server";
import { createNotification } from "@/lib/notifications/create";
import { queueDelivery } from "@/lib/integrations/webhook-dispatch";
import { renderTemplate, type TemplateName } from "./template";
import type { AutomationAction } from "./spec";

export interface ActionOutcome {
  kind: AutomationAction["kind"];
  itemId: string;
  ok: boolean;
  /** Set when the action did nothing because nothing needed doing. */
  noop?: boolean;
  error?: string;
}

export interface ActionRun {
  rule: { id: string; name: string; orgId: string };
  ctx: AuthContext;
  /** The org's automation user: who the change log names. */
  automationUserId: string;
  /** The person whose change fired the rule; null for a schedule or a system change. */
  triggerActorId: string | null;
  correlationId: string;
  depth: number;
  now: Date;
}

interface Item {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  columnKey: string;
  ticketNumber: number;
  assigneeId: string | null;
  createdById: string;
  tags: string[];
  project: { key: string; org: { slug: string } };
}

const ITEM_SELECT = {
  id: true, orgId: true, projectId: true, title: true, columnKey: true, ticketNumber: true, assigneeId: true, createdById: true, tags: true,
  project: { select: { key: true, org: { select: { slug: true } } } },
} as const;

export async function runActions(run: ActionRun, itemId: string, actions: readonly AutomationAction[]): Promise<ActionOutcome[]> {
  const out: ActionOutcome[] = [];
  for (const action of actions) {
    try {
      const item = await prisma.workItem.findFirst({ where: { id: itemId, orgId: run.rule.orgId }, select: ITEM_SELECT });
      if (!item) {
        out.push({ kind: action.kind, itemId, ok: false, error: "The item no longer exists." });
        continue;
      }
      const noop = await runAction(run, item as Item, action);
      out.push({ kind: action.kind, itemId, ok: true, ...(noop && { noop: true }) });
    } catch (e) {
      out.push({ kind: action.kind, itemId, ok: false, error: describe(e) });
    }
  }
  return out;
}

function describe(e: unknown): string {
  if (e && typeof e === "object" && "detail" in e && typeof (e as { detail: unknown }).detail === "string") return (e as { detail: string }).detail.slice(0, 300);
  return (e instanceof Error ? e.message : "Unknown error").slice(0, 300);
}

/** Returns true when there was nothing to do. */
async function runAction(run: ActionRun, item: Item, action: AutomationAction): Promise<boolean> {
  const { ctx } = run;
  // Every action needs the project to be the owner's to see, and the item theirs to edit.
  await requireProjectRead(ctx, item.projectId, "ITEM_UPDATE");
  await requireAccess(ctx, "ITEM_UPDATE", { createdById: item.createdById, assigneeId: item.assigneeId, projectId: item.projectId });

  const meta: WriteMeta = { actorId: run.automationUserId, source: "AUTOMATION", correlationId: run.correlationId, depth: run.depth, causedByRuleId: run.rule.id };

  switch (action.kind) {
    case "transition":
      if (item.columnKey === action.to) return true;
      if (action.cancel) {
        // A reason only goes with a cancel: on any other move it would stick to the item.
        const [dest] = await loadStatusCategories(prisma, item.projectId, [action.to]);
        if (dest?.category === "CANCELLED") return change(run, item, { columnKey: action.to, cancelReason: action.cancel.reason, cancelNote: action.cancel.note ?? null });
      }
      return change(run, item, { columnKey: action.to });
    case "setField": {
      if (action.field === "teamId") {
        const err = await teamProjectError({ projectId: item.projectId, teamId: action.value });
        if (err) throw new Error(err);
      }
      const value =
        action.field === "dueDate" || action.field === "startDate"
          ? action.value && new Date(Date.UTC(run.now.getUTCFullYear(), run.now.getUTCMonth(), run.now.getUTCDate() + action.value.daysFromNow)).toISOString()
          : action.value;
      return change(run, item, { [action.field]: value } as WorkItemPatch);
    }
    case "assign": {
      const to = action.to === "unassigned" ? null : action.to === "triggerActor" ? run.triggerActorId : action.to.userId;
      if (action.to === "triggerActor" && !to) throw new Error("No person made the change that fired this rule.");
      if (item.assigneeId === to) return true;
      return change(run, item, { assigneeId: to });
    }
    case "addLabels":
    case "removeLabels": {
      const lower = new Set(action.labels.map((l) => l.toLowerCase()));
      const next =
        action.kind === "addLabels"
          ? [...item.tags, ...action.labels.filter((l) => !item.tags.some((t) => t.toLowerCase() === l.toLowerCase()))]
          : item.tags.filter((t) => !lower.has(t.toLowerCase()));
      if (next.length === item.tags.length && next.every((t, i) => t === item.tags[i])) return true;
      await prisma.$transaction((tx) => setWorkItemLabels(tx, item.orgId, item.id, next, meta));
      return false;
    }
    case "addComment":
      await prisma.comment.create({
        data: { orgId: item.orgId, workItemId: item.id, authorId: run.automationUserId, content: renderTemplate(action.body, "comment", await values(run, item)) },
      });
      return false;
    case "notify": {
      const ids =
        typeof action.to === "object"
          ? action.to.userIds
          : [action.to === "assignee" ? item.assigneeId : action.to === "creator" ? item.createdById : run.triggerActorId];
      // Only people who can see the item: a notification names it.
      const members = await prisma.orgMember.findMany({
        where: { orgId: item.orgId, userId: { in: ids.filter((x): x is string => !!x) }, removedAt: null, user: { deactivatedAt: null, isBot: false } },
        select: { userId: true },
      });
      const recipients = [];
      for (const m of members) {
        const theirs = await loadMemberAuthContext(item.orgId, m.userId);
        if (theirs && hasPermission(theirs.permissions, Permission.ITEM_READ) && (await isProjectVisible(theirs, item.projectId))) recipients.push(m);
      }
      if (recipients.length === 0) return true;
      const v = await values(run, item);
      const message = renderTemplate(action.message, "notification", v);
      for (const r of recipients) {
        await createNotification({
          orgId: item.orgId,
          userId: r.userId,
          type: "automation.notify",
          title: `${run.rule.name}: ${v["item.key"]}`,
          message,
          relatedType: "work_item",
          relatedId: item.id,
          url: v["item.url"],
        });
      }
      return false;
    }
    case "webhook": {
      const hook = await prisma.webhook.findFirst({ where: { id: action.webhookId, orgId: item.orgId, active: true }, select: { id: true } });
      if (!hook) throw new Error("That webhook no longer exists or is switched off.");
      // Ids and keys only, like every webhook payload.
      await queueDelivery(hook.id, "automation.rule", {
        ruleId: run.rule.id,
        ruleName: run.rule.name,
        orgId: item.orgId,
        projectId: item.projectId,
        workItem: { id: item.id, key: `${item.project.key}-${item.ticketNumber}` },
        correlationId: run.correlationId,
      });
      return false;
    }
    case "archive":
      return change(run, item, { archivedAt: run.now.toISOString() });
  }
}

async function change(run: ActionRun, item: Item, patch: WorkItemPatch): Promise<boolean> {
  const { effects } = await prisma.$transaction((tx) =>
    applyWorkItemChange(tx, {
      actorId: run.automationUserId,
      orgId: item.orgId,
      projectId: item.projectId,
      itemIds: [item.id],
      patch,
      source: "AUTOMATION",
      actor: run.ctx,
      correlationId: run.correlationId,
      chain: { depth: run.depth, causedByRuleId: run.rule.id },
    }),
  );
  await runAfterCommit(effects);
  return false;
}

async function values(run: ActionRun, item: Item): Promise<Partial<Record<TemplateName, string | null>>> {
  const [status, actor] = await Promise.all([
    prisma.workflowStatus.findFirst({ where: { projectId: item.projectId, key: item.columnKey }, select: { name: true } }),
    run.triggerActorId ? prisma.user.findUnique({ where: { id: run.triggerActorId }, select: { displayName: true } }) : null,
  ]);
  const key = `${item.project.key}-${item.ticketNumber}`;
  return {
    "item.key": key,
    "item.title": item.title,
    "item.status": status?.name ?? item.columnKey,
    "item.url": `/${item.project.org.slug}/issues?item=${item.id}`,
    "actor.name": actor?.displayName ?? null,
    "rule.name": run.rule.name,
  };
}
