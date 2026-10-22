import type { Prisma } from "@prisma/client";
import { ensureCancelledColumn } from "@/lib/work-items/cancel.server";
import { setWorkItemLabels } from "@/lib/work-items/labels";

/**
 * COSMOS-207: merge a duplicate into the item that survives.
 *
 * The rule the owner chose is "survivor wins":
 *  - FIELDS: the survivor keeps every value it has; only its EMPTY fields are
 *    filled from the duplicate (description, dates, points, estimates,
 *    interval, parent, assignees as a set, missing custom fields).
 *  - TRACKED WORK moves, so nothing is hidden or lost: comments, time entries,
 *    sub-items, attachments, dependency links, OKR / goal / milestone links,
 *    retro action items and feedback. Watchers and labels are unioned.
 *  - The duplicate itself stays: Cancelled with reason MERGED, pointing at the
 *    survivor (mergedIntoId) and linked to it as DUPLICATES, so a search or an
 *    old link still lands somewhere that explains where the work went.
 */

export class MergeError extends Error {}

type Tx = Prisma.TransactionClient;

export interface MergeResult {
  survivorId: string;
  mergedId: string;
  moved: { comments: number; timeEntries: number; children: number; attachments: number; links: number };
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "";

export async function mergeWorkItems(
  tx: Tx,
  args: { orgId: string; projectId: string; duplicateId: string; survivorId: string; userId: string },
): Promise<MergeResult> {
  const { orgId, projectId, duplicateId: aId, survivorId: bId, userId } = args;
  if (aId === bId) throw new MergeError("An item can't be merged into itself.");

  const [a, b] = await Promise.all([
    tx.workItem.findFirst({ where: { id: aId, orgId, projectId }, include: { assignees: true } }),
    tx.workItem.findFirst({ where: { id: bId, orgId, projectId }, include: { assignees: true } }),
  ]);
  if (!a || !b) throw new MergeError("Both items must be in this project.");
  if (a.mergedIntoId) throw new MergeError("This item was already merged.");
  if (b.mergedIntoId || b.cancelReason) {
    throw new MergeError("Merge into an open item, not one that was cancelled or merged.");
  }
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { key: true } });
  const ref = (n: number) => `${project.key}-${n}`;

  // ── Fields: fill the survivor's gaps, never overwrite ──────────────────────
  const fill: Prisma.WorkItemUncheckedUpdateInput = {};
  const scalarKeys = [
    "description", "startDate", "dueDate", "storyPoints", "intervalId",
    "originalEstimate", "remainingEstimate", "timeSpent",
  ] as const;
  for (const k of scalarKeys) {
    if (isEmpty(b[k]) && !isEmpty(a[k])) (fill as Record<string, unknown>)[k] = a[k];
  }
  // A parent, unless it would make the survivor its own ancestor's child loop.
  if (!b.parentId && a.parentId && a.parentId !== bId) fill.parentId = a.parentId;
  const aCustom = (a.customFields ?? {}) as Record<string, unknown>;
  const bCustom = (b.customFields ?? {}) as Record<string, unknown>;
  const missing = Object.entries(aCustom).filter(([k, v]) => isEmpty(bCustom[k]) && !isEmpty(v));
  if (missing.length) fill.customFields = { ...bCustom, ...Object.fromEntries(missing) } as Prisma.InputJsonValue;
  // Assignees are one field (who owns it): taken only when the survivor has none.
  if (b.assignees.length === 0 && a.assignees.length > 0) {
    await tx.workItemAssignee.createMany({
      data: a.assignees.map((x) => ({ workItemId: bId, userId: x.userId, sortOrder: x.sortOrder })),
      skipDuplicates: true,
    });
    fill.assigneeId = a.assigneeId;
  }
  const tags = [...new Set([...b.tags, ...a.tags])];
  if (tags.length !== b.tags.length) {
    fill.tags = tags;
    await setWorkItemLabels(tx, orgId, bId, tags);
  }
  if (Object.keys(fill).length) await tx.workItem.update({ where: { id: bId }, data: fill });

  // ── Tracked work moves to the survivor ─────────────────────────────────────
  const comments = await tx.comment.updateMany({ where: { workItemId: aId }, data: { workItemId: bId } });
  const timeEntries = await tx.timeEntry.updateMany({ where: { workItemId: aId }, data: { workItemId: bId } });
  // Sub-items, except the survivor itself if it was one of them.
  const children = await tx.workItem.updateMany({
    where: { parentId: aId, id: { not: bId } },
    data: { parentId: bId },
  });
  if (b.parentId === aId) await tx.workItem.update({ where: { id: bId }, data: { parentId: a.parentId } });
  const attachments = await tx.document.updateMany({ where: { workItemId: aId }, data: { workItemId: bId } });
  await tx.retroActionItem.updateMany({ where: { workItemId: aId }, data: { workItemId: bId } });
  await tx.feedbackItem.updateMany({ where: { workItemId: aId }, data: { workItemId: bId } });
  await tx.goalLink.updateMany({ where: { workItemId: aId }, data: { workItemId: bId } });

  // Unique per item: copy what the survivor lacks, then drop the duplicate's.
  const watchers = await tx.workItemWatcher.findMany({ where: { workItemId: aId } });
  await tx.workItemWatcher.createMany({
    data: watchers.map((w) => ({ orgId, workItemId: bId, userId: w.userId })),
    skipDuplicates: true,
  });
  for (const [model, key] of [
    ["keyResultLink", "keyResultId"],
    ["objectiveLink", "objectiveId"],
  ] as const) {
    const delegate = tx[model] as unknown as {
      findMany: (a: object) => Promise<Record<string, string>[]>;
      createMany: (a: object) => Promise<unknown>;
      deleteMany: (a: object) => Promise<unknown>;
    };
    const rows = await delegate.findMany({ where: { workItemId: aId } });
    await delegate.createMany({
      data: rows.map((r) => ({ orgId, [key]: r[key], workItemId: bId })),
      skipDuplicates: true,
    });
    await delegate.deleteMany({ where: { workItemId: aId } });
  }
  const milestoneRows = await tx.milestoneLink.findMany({ where: { workItemId: { in: [aId, bId] } } });
  const bMilestones = new Set(milestoneRows.filter((m) => m.workItemId === bId).map((m) => m.milestoneId));
  for (const m of milestoneRows.filter((r) => r.workItemId === aId)) {
    if (bMilestones.has(m.milestoneId)) await tx.milestoneLink.delete({ where: { id: m.id } });
    else await tx.milestoneLink.update({ where: { id: m.id }, data: { workItemId: bId } });
  }

  // Dependency links: re-point each end at the survivor, dropping any that
  // would become a self-link or repeat one the survivor already has.
  const links = await tx.workItemLink.findMany({
    where: { OR: [{ sourceItemId: { in: [aId, bId] } }, { targetItemId: { in: [aId, bId] } }] },
  });
  const sig = (s: string, t: string, type: string) => `${s}>${t}:${type}`;
  const have = new Set(
    links.filter((l) => l.sourceItemId !== aId && l.targetItemId !== aId).map((l) => sig(l.sourceItemId, l.targetItemId, l.type)),
  );
  let movedLinks = 0;
  for (const l of links.filter((x) => x.sourceItemId === aId || x.targetItemId === aId)) {
    const s = l.sourceItemId === aId ? bId : l.sourceItemId;
    const t = l.targetItemId === aId ? bId : l.targetItemId;
    if (s === t || have.has(sig(s, t, l.type))) {
      await tx.workItemLink.delete({ where: { id: l.id } });
      continue;
    }
    await tx.workItemLink.update({ where: { id: l.id }, data: { sourceItemId: s, targetItemId: t } });
    have.add(sig(s, t, l.type));
    movedLinks++;
  }
  await tx.workItemLink.create({ data: { orgId, sourceItemId: aId, targetItemId: bId, type: "DUPLICATES" } });

  // ── The duplicate: Cancelled, merged, pointing at the survivor ─────────────
  const cancelledKey = await ensureCancelledColumn(tx, projectId);
  await tx.workItem.update({
    where: { id: aId },
    data: {
      columnKey: cancelledKey,
      columnEnteredAt: new Date(),
      completedAt: null,
      cancelReason: "MERGED",
      cancelNote: `Merged into ${ref(b.ticketNumber)}`,
      mergedIntoId: bId,
    },
  });
  await tx.activity.createMany({
    data: [
      { orgId, workItemId: aId, userId, action: "merged", field: "mergedIntoId", oldValue: null, newValue: ref(b.ticketNumber) },
      { orgId, workItemId: bId, userId, action: "merged", field: "mergedFrom", oldValue: null, newValue: ref(a.ticketNumber) },
    ],
  });

  return {
    survivorId: bId,
    mergedId: aId,
    moved: {
      comments: comments.count,
      timeEntries: timeEntries.count,
      children: children.count,
      attachments: attachments.count,
      links: movedLinks,
    },
  };
}
