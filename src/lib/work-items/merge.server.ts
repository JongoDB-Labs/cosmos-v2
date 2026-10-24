import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { applyWorkItemChange } from "@/lib/work-items/apply-change.server";
import type { WriteMeta } from "@/lib/work-items/events.server";
import { updateWorkItems } from "@/lib/work-items/write.server";
import { setWorkItemLabels } from "@/lib/work-items/labels";
import { hardWipColumns, lockInOrder } from "@/lib/workflow/engine.server";
import { ensureCancelledStatus } from "@/lib/workflow/statuses.server";

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

/** Deeper than any real hierarchy; stops a walk over pre-existing bad data. */
const MAX_DEPTH = 50;

/** `id` and its ancestors, nearest first, up to MAX_DEPTH. */
async function lineage(tx: Tx, id: string | null): Promise<string[]> {
  const out: string[] = [];
  for (let cur = id; cur && out.length < MAX_DEPTH && !out.includes(cur); ) {
    out.push(cur);
    cur = (await tx.workItem.findUnique({ where: { id: cur }, select: { parentId: true } }))?.parentId ?? null;
  }
  return out;
}

export async function mergeWorkItems(
  tx: Tx,
  args: { orgId: string; projectId: string; duplicateId: string; survivorId: string; userId: string },
): Promise<MergeResult> {
  const { orgId, projectId, duplicateId: aId, survivorId: bId, userId } = args;
  // The same source as the cancel below, so the merge's events read as one change.
  const meta: WriteMeta = { actorId: userId, source: "SYSTEM", correlationId: randomUUID() };
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
  // Lock everything this merge writes, first and in the one order every change
  // takes (lockInOrder): it fills the survivor and moves the duplicate's
  // sub-items before the cancel below, and a bulk move taking the same rows in
  // the other order would otherwise deadlock with it.
  const cancelled = await ensureCancelledStatus(tx, projectId);
  const subItems = await tx.workItem.findMany({ where: { parentId: aId }, select: { id: true } });
  await lockInOrder(
    tx,
    projectId,
    await hardWipColumns(tx, projectId, [cancelled]),
    [aId, bId, ...(a.parentId ? [a.parentId] : []), ...(b.parentId ? [b.parentId] : []), ...subItems.map((c) => c.id)],
  );
  const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { key: true } });
  const ref = (n: number) => `${project.key}-${n}`;

  // ── Fields: fill the survivor's gaps, never overwrite ──────────────────────
  const fill: Prisma.WorkItemUncheckedUpdateManyInput = {};
  const scalarKeys = [
    "description", "startDate", "dueDate", "storyPoints", "intervalId",
    // timeSpent is entered by hand (or imported); nothing derives it from time
    // entries or adds the two, so filling it while the entries also move does
    // not double-count.
    "originalEstimate", "remainingEstimate", "timeSpent",
  ] as const;
  for (const k of scalarKeys) {
    if (isEmpty(b[k]) && !isEmpty(a[k])) (fill as Record<string, unknown>)[k] = a[k];
  }
  // The hierarchy must stay a tree. `aLine` is the duplicate's parent and its
  // ancestors; `bAbove` is everything above the survivor.
  const aLine = await lineage(tx, a.parentId);
  const bAbove = new Set(await lineage(tx, b.parentId));
  // Take the duplicate's parent only if the survivor isn't above it (it would
  // become a child of its own descendant).
  if (!b.parentId && a.parentId && !aLine.includes(bId)) fill.parentId = a.parentId;
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
    await setWorkItemLabels(tx, orgId, bId, tags, meta);
  }
  if (Object.keys(fill).length) await updateWorkItems(tx, [bId], fill, meta);

  // ── Tracked work moves to the survivor ─────────────────────────────────────
  const comments = await tx.comment.updateMany({ where: { workItemId: aId }, data: { workItemId: bId } });
  const timeEntries = await tx.timeEntry.updateMany({ where: { workItemId: aId }, data: { workItemId: bId } });
  // Sub-items move under the survivor, except the one on the survivor's own
  // path up (the survivor itself, or the ancestor of it that hangs off the
  // duplicate): moving that under the survivor would make a loop. It takes the
  // duplicate's place instead, under the duplicate's parent, unless even that
  // would loop, when it becomes top-level.
  const onPath = [bId, ...bAbove];
  const movedChildren = await tx.workItem.findMany({
    where: { parentId: aId, id: { notIn: onPath } },
    select: { id: true },
  });
  const children = { count: await updateWorkItems(tx, movedChildren.map((c) => c.id), { parentId: bId }, meta) };
  const lifted = await tx.workItem.findFirst({ where: { parentId: aId, id: { in: onPath } }, select: { id: true } });
  if (lifted) {
    const safeParent = a.parentId && !aLine.includes(lifted.id) && !aLine.includes(bId) ? a.parentId : null;
    await updateWorkItems(tx, [lifted.id], { parentId: safeParent }, meta);
  }
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
  // A cancel like any other, through the one writer: the MERGED reason finds
  // (or creates) the Cancelled status, clears the actual end, and records the
  // move in the duplicate's history. The merge route runs its own after-commit
  // work, so the change's effects are not needed here.
  await applyWorkItemChange(tx, {
    actorId: userId,
    orgId,
    projectId,
    itemIds: [aId],
    patch: { cancelReason: "MERGED", cancelNote: `Merged into ${ref(b.ticketNumber)}`, mergedIntoId: bId },
    source: "SYSTEM",
    correlationId: meta.correlationId,
    // The system's own cancel: held to the workflow's structure, not a person's rights.
    actor: null,
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
