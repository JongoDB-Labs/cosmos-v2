/**
 * What a committed work-item change sets off: re-embedding, the audit line,
 * the live-update event, the linked feedback's status, the new assignee's
 * notification and the Teams "completed" message.
 *
 * These used to run inline in the PUT route only, so a bulk move or an
 * assistant edit skipped most of them. `applyWorkItemChange` now describes each
 * change as `AfterCommitEffects`, and every caller hands that to
 * `runAfterCommit` once its transaction has committed.
 *
 * Every effect is best-effort: a failure here never fails the change, which has
 * already been saved.
 */
import { prisma } from "@/lib/db/client";
import { logAudit } from "@/lib/audit";
import { createNotification } from "@/lib/notifications/create";
import { publishToOrg } from "@/lib/realtime/broker";
import { teamsNotify, escapeHtmlBasic } from "@/lib/integrations/teams-notify";
import { storeEmbedding } from "@/lib/rag/embed";
import { syncFeedbackForWorkItems } from "@/lib/feedback/status-sync";
import type { Denial } from "@/lib/workflow/engine.server";
import type { ChangeSource } from "@/lib/work-items/apply-change.server";

/** How many tickets a bulk "completed" Teams message names before "and N more". */
const TEAMS_LISTED = 10;

export interface ChangedItem {
  id: string;
  ticketNumber: number;
  before: { title: string; columnKey: string; assigneeId: string | null; completedAt: Date | null };
  after: { title: string; description: string; columnKey: string; completedAt: Date | null };
}

export interface AfterCommitEffects {
  orgId: string;
  projectId: string;
  actorId: string;
  source: ChangeSource;
  /** The fields the change named, for the audit line. */
  fields: string[];
  /** Title or description changed, so the search embedding is stale. */
  textChanged: boolean;
  /** The change named a status (moved or not). */
  columnTouched: boolean;
  /** The single assignee the change named, if it named one. */
  assigneeId: string | null | undefined;
  items: ChangedItem[];
  /** Refusals the workflow went past: forced by an override, or only recorded in shadow mode. */
  workflow?: { forced: Denial[]; shadow: Denial[] };
}

/** Several change results (a bulk edit's batches) as one. */
export function mergeEffects(parts: AfterCommitEffects[]): AfterCommitEffects | null {
  if (parts.length === 0) return null;
  return {
    ...parts[0],
    items: parts.flatMap((p) => p.items),
    workflow: {
      forced: parts.flatMap((p) => p.workflow?.forced ?? []),
      shadow: parts.flatMap((p) => p.workflow?.shadow ?? []),
    },
  };
}

export async function runAfterCommit(
  effects: AfterCommitEffects,
  opts: { ipAddress?: string } = {},
): Promise<void> {
  const { orgId, projectId, actorId, items } = effects;
  if (items.length === 0) return;
  const bulk = effects.source === "BULK";

  // Every change forced past the workflow is audited with what it bypassed
  // (design §4.4); shadow-mode refusals are recorded so admins can see what an
  // enforced workflow would have blocked.
  for (const [action, denials] of [
    ["work_item.transition_forced", effects.workflow?.forced ?? []],
    ["workflow.shadow_denied", effects.workflow?.shadow ?? []],
  ] as const) {
    for (const d of denials) {
      await logAudit({
        orgId,
        userId: actorId,
        action,
        entity: "work_item",
        entityId: d.itemId,
        metadata: {
          code: d.body.code,
          message: d.body.error,
          ...(d.body.transition && { transition: d.body.transition.id }),
          ...(d.body.reasons && { reasons: d.body.reasons.map((r) => r.validator).join(", ") }),
        },
        ipAddress: opts.ipAddress,
      });
    }
  }

  // RAG: re-embed when searchable text changed.
  if (effects.textChanged) {
    for (const item of items) {
      await storeEmbedding("work_items", item.id, `${item.after.title}\n${item.after.description}`).catch(
        (err: unknown) => console.warn("[rag] failed to persist work item embedding:", (err as Error).message),
      );
    }
  }

  if (bulk) {
    await logAudit({
      orgId,
      userId: actorId,
      action: "work_item.bulk_updated",
      entity: "work_item",
      metadata: { count: String(items.length), fields: effects.fields.join(", ") },
      ipAddress: opts.ipAddress,
    });
  } else {
    for (const item of items) {
      await logAudit({
        orgId,
        userId: actorId,
        action: "work_item.updated",
        entity: "work_item",
        entityId: item.id,
        metadata: { changes: effects.fields.join(", ") },
        ipAddress: opts.ipAddress,
      });
    }
  }

  // Live updates: tell other clients viewing this project's boards/issues to
  // refresh. Best-effort — a broker error never breaks the change.
  try {
    if (bulk) {
      publishToOrg(orgId, "work-item.updated", { ids: items.map((i) => i.id) });
    } else {
      for (const item of items) {
        publishToOrg(orgId, "work-item.updated", {
          id: item.id,
          projectId,
          columnKey: item.after.columnKey,
          ticketNumber: item.ticketNumber,
        });
      }
    }
  } catch {
    /* never let a broker error break the update */
  }

  // Reflect a status move onto any feedback item the work was delivered from
  // (PLANNED → IN_PROGRESS → DONE follow the board). Best-effort inside.
  if (effects.columnTouched) {
    const moved = items.filter((i) => i.after.columnKey !== i.before.columnKey).map((i) => i.id);
    if (moved.length > 0) await syncFeedbackForWorkItems(moved);
  }

  // Notify the new assignee, unless they assigned themselves.
  const assigneeId = effects.assigneeId;
  if (assigneeId && assigneeId !== actorId) {
    const notified = items.filter((i) => i.before.assigneeId !== assigneeId);
    if (notified.length > 0) {
      const [actor, org] = await Promise.all([
        prisma.user.findUnique({ where: { id: actorId }, select: { displayName: true, email: true } }).catch(() => null),
        prisma.organization.findUnique({ where: { id: orgId }, select: { slug: true } }).catch(() => null),
      ]);
      const actorName = actor?.displayName || actor?.email || "Someone";
      for (const item of notified) {
        const itemLabel = item.ticketNumber ? `#${item.ticketNumber} ${item.before.title}` : item.before.title;
        await createNotification({
          orgId,
          userId: assigneeId,
          type: "work_item.assigned",
          title: `Assigned: ${itemLabel}`,
          message: `${actorName} assigned you a work item`,
          relatedType: "work_item",
          relatedId: item.id,
          url: `/${org?.slug ?? ""}/issues?item=${item.id}`,
        }).catch(() => {
          /* notification is convenience, not load-bearing */
        });
      }
    }
  }

  // Teams (FR 8a162fe7): work newly COMPLETED. One message per change, so a
  // bulk move into Done is one line rather than one per item.
  const completed = items.filter((i) => i.after.completedAt && !i.before.completedAt);
  if (completed.length > 0) {
    void (async () => {
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { key: true } });
      const key = project?.key ?? "";
      const message =
        completed.length === 1
          ? `✅ <b>${key}-${completed[0].ticketNumber}</b> ${escapeHtmlBasic(completed[0].after.title)} completed`
          : `✅ ${completed.length} items completed in <b>${key}</b>: ${completed
              .slice(0, TEAMS_LISTED)
              .map((i) => `${key}-${i.ticketNumber}`)
              .join(", ")}${completed.length > TEAMS_LISTED ? ` and ${completed.length - TEAMS_LISTED} more` : ""}`;
      await teamsNotify(orgId, "itemCompleted", message);
    })().catch(() => {});
  }
}
