/**
 * `applyWorkItemChange`: the one implementation of "change these work items".
 *
 * The single-item PUT, the bulk edit, the assistant, merge and every later
 * caller (workflow transitions, automations) run the same steps, in the same
 * transaction as the caller's other writes:
 *
 *  1. resolve the destination status (a cancel finds or creates Cancelled);
 *  2. per item: the field writes, the status side effects (entered-at, actual
 *     start / end capture by CATEGORY, cancel fields), and the history rows;
 *  3. the label and assignee sets;
 *  4. the schedule cascade for a date edit.
 *
 * It returns what moved plus the effects to run AFTER the transaction commits
 * (`runAfterCommit` in after-commit.ts): embeddings, audit, realtime, feedback
 * sync, notifications, Teams. Running them after commit means a rolled-back
 * change never notifies anyone.
 *
 * Authorisation is the caller's: routes check `requireAccess`, the assistant
 * `assertPermission`. This function assumes the actor may make the change.
 */
import { randomUUID } from "node:crypto";
import { ColumnCategory, Priority, WorkCategory, type Prisma, type WorkItem } from "@prisma/client";
import { z } from "zod";
import { isDonePhase, isStartedPhase } from "@/lib/boards/column-phase";
import { loadStatusCategories } from "@/lib/boards/status-categories.server";
import {
  CANCEL_NOTE_MAX,
  PICKABLE_CANCEL_REASONS,
  cancelFieldsForUpdate,
  cancelInputError,
  cancelReasonLabel,
  type CancelReason,
} from "@/lib/work-items/cancel";
import { ensureCancelledStatus } from "@/lib/workflow/statuses.server";
import { gateChange, throwIfDenied, type Denial, type EnforcementLevel, type TransitionRequest } from "@/lib/workflow/engine.server";
import { TransitionError } from "@/lib/workflow/contract";
import { ProblemError } from "@/lib/openapi/problem";
import type { FieldRef } from "@/lib/workflow/definition";
import type { AuthContext } from "@/lib/rbac/check";
import { WORK_ITEM_HIGHLIGHT_ORDER } from "@/lib/work-items/highlights";
import { setLabelsForMany, setWorkItemLabels } from "@/lib/work-items/labels";
import { cascadeSchedule, type CascadedItem } from "@/lib/work-items/schedule-cascade-io";
import { changeEvents, snapshotItems, updateWorkItemsUnchecked } from "@/lib/work-items/write.server";
import { RECORDED_BY_CALLER, recordEvents, type WriteMeta } from "@/lib/work-items/events.server";
import type { AfterCommitEffects, ChangedItem } from "@/lib/work-items/after-commit";

/** The body of `PUT …/work-items/[itemId]`: every field a person may change. */
export const workItemPatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullish(),
  workItemTypeId: z.string().uuid().nullish(),
  columnKey: z.string().nullish(),
  assigneeId: z.string().uuid().nullable().optional(),
  // Multi-assign (FR 1d38496a): replaces the WHOLE set; first entry becomes the
  // primary assigneeId. When present it wins over the legacy single field.
  assigneeIds: z.array(z.string().uuid()).max(50).optional(),
  priority: z.nativeEnum(Priority).optional(),
  intervalId: z.string().uuid().nullable().optional(),
  // COSMOS-204: the owning team, independent of the assignee. null clears it.
  teamId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  storyPoints: z.number().int().min(0).nullable().optional(),
  sortOrder: z.number().int().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  // Interdependent rescheduling (COSMOS-154): the OTHER items this same user
  // action is writing by hand, each in its own request. Their dates are settled
  // by those requests, so this one's cascade must neither move them nor reach
  // past them — otherwise a multi-select Shift, or an undo restoring a whole
  // cascade, moves shared dependents once per member. Not a stored field.
  cascadeSkipIds: z.array(z.string().uuid()).max(500).optional(),
  actualStart: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  workCategory: z.nativeEnum(WorkCategory).optional(),
  // The outcome of a finished or cancelled item ("Fixed", "Won't do"); free
  // text so values imported from another tracker stay as they were.
  resolution: z.string().max(200).nullable().optional(),
  // Archive / unarchive. A timestamp in, or null to bring it back.
  //
  // It rides on this route rather than getting an endpoint of its own because
  // it is gated on ITEM_UPDATE like every other field here — which is the whole
  // point: archiving is editing, not deleting, so the person who made a mess can
  // clear it up without being handed the ability to destroy anyone's work.
  archivedAt: z.string().datetime().nullable().optional(),
  // Meeting callout colour. Validated against the palette on WRITE even though
  // reads deliberately tolerate an unknown key: the column is plain TEXT for
  // forward-compatibility with a NEWER build, which is not a licence for THIS
  // build to store a typo. A rejected value is a 400 the user can see; a stored
  // one would be an invisible no-op border they could never clear from the UI.
  // `null` clears the highlight.
  highlight: z.enum(WORK_ITEM_HIGHLIGHT_ORDER).nullable().optional(),
  tags: z.array(z.string()).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
  // Cancel with a reason (COSMOS-206). Sending a reason IS the cancel: the item
  // moves to the project's Cancelled status, which is created on first use.
  // Moving the item to any other status clears both.
  // MERGED is not accepted here: only a merge (COSMOS-207) sets it.
  cancelReason: z.enum(PICKABLE_CANCEL_REASONS).optional(),
  cancelNote: z.string().max(CANCEL_NOTE_MAX).nullish(),
}).superRefine((d, ctx) => {
  const err = d.cancelReason ? cancelInputError(d.cancelReason, d.cancelNote) : null;
  if (err) ctx.addIssue({ code: "custom", path: ["cancelNote"], message: err });
});

/**
 * A change as the server applies it: the API patch, plus what only the merge
 * service may set (the MERGED reason and the survivor it points at).
 */
export type WorkItemPatch = Omit<z.infer<typeof workItemPatchSchema>, "cancelReason"> & {
  cancelReason?: CancelReason;
  mergedIntoId?: string;
};

/**
 * Who made the change. Recorded on the after-commit effects and, from the
 * workflow engine onwards, on the domain event, so automations can tell a
 * person's edit from their own.
 */
export type ChangeSource = "API" | "BULK" | "AI" | "SYSTEM" | "MIGRATION";

export interface ApplyChangeInput {
  actorId: string;
  orgId: string;
  projectId: string;
  /** One id for a single edit; many for a bulk edit. Ids outside the project are skipped. */
  itemIds: readonly string[];
  patch: WorkItemPatch;
  source: ChangeSource;
  /** Set when this change is part of a larger one (a merge), so their events share it. */
  correlationId?: string;
  /**
   * The person acting, for the workflow's restrictions and the override right.
   * Null for a system change, which the workflow holds to its structure only.
   * Optional only for the composed plugins, whose calls predate it (left out,
   * it is a system change); every caller here passes it (write-meta.arch.test.ts).
   */
  actor?: AuthContext | null;
  /** The transition named and the input it asked for, when the client sends them. */
  transition?: TransitionRequest;
  /** The board the move was made on. Accepted, no longer needed: hard WIP limits hold from every surface. */
  boardId?: string;
  /**
   * Defaults to "none" for a workflow MIGRATION, "system" for a SYSTEM change
   * or one with no `actor` (a composed plugin's call), and "full" otherwise.
   */
  level?: EnforcementLevel;
}

export interface ApplyChangeResult {
  /** The items changed, in the order given. */
  itemIds: string[];
  /** Items the schedule cascade moved, with their before/after dates. */
  scheduleCascade: CascadedItem[];
  /** Run with `runAfterCommit` once the transaction has committed. */
  effects: AfterCommitEffects;
  /**
   * Items the workflow refused, with why. Only a BULK change gets here with
   * refusals: any other change throws the first one as a TransitionError.
   */
  denied: Denial[];
}

interface TrackedField {
  field: string;
  oldVal: string | null;
  newVal: string | null;
}

const DATE_FIELDS = ["startDate", "dueDate", "actualStart", "completedAt"] as const;

/**
 * One item's row update and history, from its current row, the patch, and the
 * category of the status it is moving to (null when the destination is unknown
 * or there is no move).
 *
 * Pure apart from `now`, which the caller passes so every item in one change
 * carries the same timestamp.
 */
export function computeItemChange(args: {
  existing: WorkItem;
  patch: WorkItemPatch;
  destCategory: ColumnCategory | null;
  now: Date;
}): { updateData: Prisma.WorkItemUncheckedUpdateManyInput; trackFields: TrackedField[] } {
  const { existing, destCategory, now } = args;
  // `columnKey: null` names no status (both schemas accept it as "nullish"), so
  // it is no move: it must not clear a cancel reason or record a move to nothing.
  const data: WorkItemPatch = args.patch.columnKey === null ? { ...args.patch, columnKey: undefined } : args.patch;
  const trackFields: TrackedField[] = [];

  if (data.title !== undefined && data.title !== existing.title) {
    trackFields.push({ field: "title", oldVal: existing.title, newVal: data.title });
  }
  if (data.columnKey !== undefined && data.columnKey !== existing.columnKey) {
    trackFields.push({ field: "columnKey", oldVal: existing.columnKey, newVal: data.columnKey });
  }
  if (data.priority !== undefined && data.priority !== existing.priority) {
    trackFields.push({ field: "priority", oldVal: existing.priority, newVal: data.priority });
  }
  if (data.assigneeId !== undefined && data.assigneeId !== existing.assigneeId) {
    trackFields.push({ field: "assigneeId", oldVal: existing.assigneeId, newVal: data.assigneeId });
  }
  // Multi-assign: the set's first member becomes the primary — track that
  // change under the same field name the activity feed already renders.
  const primaryFromSet = data.assigneeIds !== undefined ? (data.assigneeIds[0] ?? null) : undefined;
  if (primaryFromSet !== undefined && primaryFromSet !== existing.assigneeId) {
    trackFields.push({ field: "assigneeId", oldVal: existing.assigneeId, newVal: primaryFromSet });
  }
  if (data.resolution !== undefined && (data.resolution?.trim() || null) !== existing.resolution) {
    trackFields.push({ field: "resolution", oldVal: existing.resolution, newVal: data.resolution?.trim() || null });
  }
  if (data.intervalId !== undefined && data.intervalId !== existing.intervalId) {
    trackFields.push({ field: "intervalId", oldVal: existing.intervalId, newVal: data.intervalId });
  }
  if (data.teamId !== undefined && data.teamId !== existing.teamId) {
    trackFields.push({ field: "teamId", oldVal: existing.teamId, newVal: data.teamId });
  }
  if (data.workItemTypeId !== undefined && data.workItemTypeId !== existing.workItemTypeId) {
    trackFields.push({ field: "workItemTypeId", oldVal: existing.workItemTypeId, newVal: data.workItemTypeId });
  }

  const columnChanged = data.columnKey !== undefined && data.columnKey !== existing.columnKey;

  const updateData: Prisma.WorkItemUncheckedUpdateManyInput = {};
  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = data.description ?? "";
  if (data.workItemTypeId !== undefined && data.workItemTypeId !== null) {
    updateData.workItemTypeId = data.workItemTypeId;
  }
  if (data.columnKey !== undefined && data.columnKey !== null) {
    updateData.columnKey = data.columnKey;
    if (columnChanged) updateData.columnEnteredAt = now;
  }
  if (data.assigneeId !== undefined) updateData.assigneeId = data.assigneeId;
  if (data.assigneeIds !== undefined) updateData.assigneeId = data.assigneeIds[0] ?? null;
  if (data.priority !== undefined) updateData.priority = data.priority;
  if (data.intervalId !== undefined) updateData.intervalId = data.intervalId;
  if (data.teamId !== undefined) updateData.teamId = data.teamId;
  if (data.parentId !== undefined) updateData.parentId = data.parentId;
  if (data.storyPoints !== undefined) updateData.storyPoints = data.storyPoints;
  if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;
  if (data.dueDate !== undefined) updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;
  if (data.startDate !== undefined) updateData.startDate = data.startDate ? new Date(data.startDate) : null;
  if (data.actualStart !== undefined) updateData.actualStart = data.actualStart ? new Date(data.actualStart) : null;
  if (data.completedAt !== undefined) updateData.completedAt = data.completedAt ? new Date(data.completedAt) : null;
  if (data.workCategory !== undefined) updateData.workCategory = data.workCategory;
  if (data.resolution !== undefined) updateData.resolution = data.resolution?.trim() || null;
  if (data.archivedAt !== undefined) updateData.archivedAt = data.archivedAt ? new Date(data.archivedAt) : null;
  if (data.highlight !== undefined) updateData.highlight = data.highlight;
  if (data.customFields !== undefined) {
    // MERGE partial custom-field updates into the existing JSON so a PUT
    // that touches one field (the detail sheet's per-field save) never
    // clobbers the item's other custom-field values. Keys explicitly set to
    // null/undefined still overwrite — that's how the UI clears a value.
    const existingCustom =
      existing.customFields && typeof existing.customFields === "object" && !Array.isArray(existing.customFields)
        ? (existing.customFields as Record<string, unknown>)
        : {};
    updateData.customFields = { ...existingCustom, ...data.customFields } as Prisma.InputJsonValue;
  }

  // The destination status's CATEGORY decides whether this move means
  // "started" or "finished". Both checks used to guess from the key string
  // ("not backlog/todo" = started, "contains done" = finished), which stamped
  // an actual START on any team-named column such as Review — the cause of a
  // user's Gantt bars all jumping to today after a batch of Sprint-board moves.
  const doneColumn = destCategory ? isDonePhase(destCategory) : false;

  // The reason belongs to the cancellation: recorded with it, and gone once
  // the item is moved anywhere that isn't Cancelled.
  const cancelFields = cancelFieldsForUpdate({
    requested: { reason: data.cancelReason, note: data.cancelNote },
    columnChanged,
    destIsCancelled: destCategory === ColumnCategory.CANCELLED,
    existing: { reason: existing.cancelReason, note: existing.cancelNote },
  });
  if (cancelFields) {
    Object.assign(updateData, cancelFields);
    // Reopening a merged item un-merges it; its moved work stays moved.
    if (cancelFields.cancelReason === null && existing.mergedIntoId) updateData.mergedIntoId = null;
    if (cancelFields.cancelReason !== existing.cancelReason) {
      trackFields.push({ field: "cancelReason", oldVal: existing.cancelReason, newVal: cancelFields.cancelReason });
    }
  }
  if (data.mergedIntoId !== undefined) updateData.mergedIntoId = data.mergedIntoId;

  // Resolution is the outcome of a finished or cancelled item (design §3.7):
  // a cancel records its reason there unless the change names one, and a move
  // anywhere that is neither Done nor Cancelled clears it, as reopening does.
  if (data.resolution === undefined) {
    const outcomeStatus = destCategory === ColumnCategory.DONE || destCategory === ColumnCategory.CANCELLED;
    let resolution: string | null | undefined;
    if (cancelFields?.cancelReason) {
      resolution = cancelFields.cancelReason === "MERGED" ? "Duplicate" : cancelReasonLabel(cancelFields.cancelReason);
    } else if (columnChanged && destCategory && !outcomeStatus && existing.resolution) {
      resolution = null;
    }
    if (resolution !== undefined && resolution !== existing.resolution) {
      updateData.resolution = resolution;
      trackFields.push({ field: "resolution", oldVal: existing.resolution, newVal: resolution });
    }
  }

  // Actual End auto-capture (skipped when the request sets completedAt manually).
  if (data.completedAt === undefined) {
    if (doneColumn && !existing.completedAt) {
      updateData.completedAt = now;
    } else if (data.columnKey && !doneColumn && existing.completedAt) {
      updateData.completedAt = null;
    }
  }
  // Actual Start auto-capture: first time the item enters a started (in-progress
  // or done) column. Mirrors the completedAt capture; never overwritten once set;
  // a manual actualStart in this request wins.
  const startedColumn = destCategory ? isStartedPhase(destCategory) : false;
  if (data.actualStart === undefined && startedColumn && !existing.actualStart) {
    updateData.actualStart = now;
  }

  // DATE AUDIT. Every date on the item, diffed from the FINAL updateData
  // rather than from the request body — the 2026-08-14 incident was caused by
  // an AUTO-CAPTURED actualStart that the client never sent, so tracking only
  // what the caller asked for would have recorded nothing and left no trail of
  // the very change that caused the report. Recording the derived value is the
  // whole point.
  for (const field of DATE_FIELDS) {
    if (!(field in updateData)) continue;
    const before = existing[field];
    const after = updateData[field] as Date | null;
    const beforeIso = before ? new Date(before).toISOString() : null;
    const afterIso = after ? new Date(after).toISOString() : null;
    if (beforeIso !== afterIso) trackFields.push({ field, oldVal: beforeIso, newVal: afterIso });
  }

  return { updateData, trackFields };
}

/** Values in a stable order, Dates as ISO, so equal updates group together. */
function updateKey(data: Prisma.WorkItemUncheckedUpdateManyInput): string {
  return JSON.stringify(Object.entries(data).sort(([a], [b]) => a.localeCompare(b)));
}


/** The message for an assignee who isn't in the org, whether or not the id exists. */
const NOT_A_MEMBER = "That person isn't a member of this organization.";

/**
 * The org's members who can be given work: still in the org (not removed) and
 * with an account that isn't deactivated, as calendar invitees are chosen.
 */
export function assignableMembersWhere(orgId: string, userIds: readonly string[]): Prisma.OrgMemberWhereInput {
  return { orgId, userId: { in: [...userIds] }, removedAt: null, user: { deactivatedAt: null } };
}

/** Whether every one of these user ids is an assignable member of the org. */
async function membersAmong(tx: Prisma.TransactionClient, orgId: string, ids: readonly string[]): Promise<boolean> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return true;
  return (await tx.orgMember.count({ where: assignableMembersWhere(orgId, unique) })) === unique.length;
}

/**
 * Every assignee must be a member of the item's org. An id that doesn't exist
 * and a user from another org get the SAME 422 `assignee_not_in_org`, so the answer says nothing
 * about which users exist on the platform, and an item is never assigned
 * across tenants. (Before, an unknown id was a 500 and an outsider was
 * assigned.) Used for every write that names assignees: the change service
 * and work-item create.
 */
export async function assertAssigneesInOrg(
  tx: Prisma.TransactionClient,
  orgId: string,
  ids: readonly (string | null | undefined)[],
): Promise<void> {
  const named = ids.filter((id): id is string => !!id);
  if (!(await membersAmong(tx, orgId, named))) throw new ProblemError(422, "assignee_not_in_org", NOT_A_MEMBER);
}

/**
 * Hold the fields a transition added to a change to the rules the request
 * body met: the patch schema, a team of this project, assignees in this org,
 * an interval of this project. A value the caller sent unchanged was checked
 * by the route, so only what differs from `base` is looked up.
 */
async function checkTransitionPatch(
  tx: Prisma.TransactionClient,
  args: { orgId: string; projectId: string; base: WorkItemPatch; patch: WorkItemPatch },
): Promise<void> {
  const refuse = (message: string, field: FieldRef): never => {
    throw new TransitionError({
      error: message,
      code: "transition_invalid",
      reasons: [{ validator: "input", message, fields: [field] }],
    });
  };
  const p = args.patch;
  const changed = (k: keyof WorkItemPatch) => p[k] !== undefined && JSON.stringify(p[k]) !== JSON.stringify(args.base[k]);
  const added = Object.fromEntries((Object.keys(p) as (keyof WorkItemPatch)[]).filter(changed).map((k) => [k, p[k]]));
  const parsed = workItemPatchSchema.safeParse(added);
  if (!parsed.success) {
    const key = String(parsed.error.issues[0]?.path[0] ?? "");
    const message = "A value for this step isn't valid.";
    throw new TransitionError({ error: message, code: "transition_invalid", reasons: [{ validator: "input", message, ...(key && { fields: [{ system: key } as FieldRef] }) }] });
  }

  if (changed("teamId") && p.teamId) {
    const team = await tx.team.count({ where: { id: p.teamId, projectId: args.projectId } });
    if (team === 0) refuse("That team isn't part of this project.", { system: "teamId" });
  }
  if (changed("intervalId") && p.intervalId) {
    const interval = await tx.interval.count({ where: { id: p.intervalId, projectId: args.projectId } });
    if (interval === 0) refuse("That interval isn't part of this project.", { system: "intervalId" });
  }
  const assignees = [
    ...(changed("assigneeId") && p.assigneeId ? [p.assigneeId] : []),
    ...(changed("assigneeIds") ? (p.assigneeIds ?? []) : []),
  ];
  if (!(await membersAmong(tx, args.orgId, assignees))) refuse(NOT_A_MEMBER, { system: "assigneeId" });
}
/**
 * Sync the assignee SET with the patch, before the rows are read back:
 * - `assigneeIds` replaces each item's set wholesale (order = payload);
 * - a single `assigneeId` is promoted to the FRONT of the set (extras are
 *   kept: sortOrder -1, and the set is read ordered ascending);
 * - `assigneeId: null` clears the set: "Unassigned" from any surface means nobody.
 */
async function syncAssigneeSets(tx: Prisma.TransactionClient, ids: string[], patch: WorkItemPatch) {
  if (patch.assigneeIds !== undefined) {
    const assigneeIds = patch.assigneeIds;
    await tx.workItemAssignee.deleteMany({ where: { workItemId: { in: ids } } });
    if (assigneeIds.length > 0) {
      await tx.workItemAssignee.createMany({
        data: ids.flatMap((workItemId) => assigneeIds.map((userId, i) => ({ workItemId, userId, sortOrder: i }))),
        skipDuplicates: true,
      });
    }
  } else if (patch.assigneeId !== undefined) {
    if (patch.assigneeId === null) {
      await tx.workItemAssignee.deleteMany({ where: { workItemId: { in: ids } } });
    } else {
      const userId = patch.assigneeId;
      // An upsert per item, set-based: add where missing, then move to the front.
      await tx.workItemAssignee.createMany({
        data: ids.map((workItemId) => ({ workItemId, userId, sortOrder: -1 })),
        skipDuplicates: true,
      });
      await tx.workItemAssignee.updateMany({
        where: { workItemId: { in: ids }, userId },
        data: { sortOrder: -1 },
      });
    }
  }
}

export async function applyWorkItemChange(
  tx: Prisma.TransactionClient,
  input: ApplyChangeInput,
): Promise<ApplyChangeResult> {
  const { actorId, orgId, projectId, source } = input;
  // One correlation id for everything this change writes, the cascade included.
  const meta: WriteMeta = { actorId, source, correlationId: input.correlationId ?? randomUUID() };
  const patch: WorkItemPatch = { ...input.patch };
  // `columnKey: null` names no status: no move (see computeItemChange).
  if (patch.columnKey === null) delete patch.columnKey;

  const rows = await tx.workItem.findMany({ where: { id: { in: [...input.itemIds] }, orgId, projectId } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = input.itemIds.flatMap((id) => byId.get(id) ?? []);

  // A cancel names no column of its own: resolve (or create) the project's
  // Cancelled status first, so everything below treats it as a column move.
  if (patch.cancelReason) {
    patch.columnKey = await ensureCancelledStatus(tx, projectId, patch.columnKey);
  }
  // Before anything else is decided: the people named must be in this org.
  await assertAssigneesInOrg(tx, orgId, [patch.assigneeId, ...(patch.assigneeIds ?? [])]);

  const now = new Date();
  // The workflow first: nothing is written for an item it refuses. Each item
  // that passes carries its own patch (the transition's input and actions).
  const gate = await gateChange(tx, {
    orgId,
    projectId,
    actor: input.actor ?? null,
    actorId,
    level: input.level ?? (source === "MIGRATION" ? "none" : source === "SYSTEM" || input.actor === undefined ? "system" : "full"),
    items,
    patch,
    transition: input.transition,
    boardId: input.boardId,
    now,
  });
  if (source !== "BULK") throwIfDenied(gate);
  // What a transition folded in (its input, its actions) skipped the route's
  // checks on the request body: hold it to them here, before anything is written.
  const checked = new Set<WorkItemPatch>([patch]);
  for (const g of gate.gates) {
    if (checked.has(g.patch)) continue;
    checked.add(g.patch);
    await checkTransitionPatch(tx, { orgId, projectId, base: patch, patch: g.patch });
  }
  const passed = new Map(gate.gates.map((g) => [g.itemId, g]));
  const allowed = items.filter((i) => passed.has(i.id));
  const ids = allowed.map((i) => i.id);

  // Items whose effective patches are equal are changed together.
  const patchGroups = new Map<string, { patch: WorkItemPatch; items: WorkItem[] }>();
  for (const item of allowed) {
    const p = passed.get(item.id)!.patch;
    const key = JSON.stringify(p);
    const group = patchGroups.get(key) ?? { patch: p, items: [] };
    group.items.push(item);
    patchGroups.set(key, group);
  }
  const groupPatches = [...patchGroups.values()].map((g) => g.patch);
  const effectivePatch = groupPatches.length === 1 ? groupPatches[0] : patch;

  const effects: AfterCommitEffects = {
    orgId,
    projectId,
    actorId,
    source,
    fields: [...new Set(groupPatches.length > 0 ? groupPatches.flatMap((p) => Object.keys(p)) : Object.keys(patch))],
    textChanged: groupPatches.some((p) => p.title !== undefined || p.description !== undefined),
    columnTouched: patch.columnKey !== undefined,
    assigneeId: effectivePatch.assigneeId,
    items: [],
    workflow: { forced: gate.forced, shadow: gate.shadow },
  };
  if (allowed.length === 0) return { itemIds: [], scheduleCascade: [], effects, denied: gate.denials };

  const changes: { existing: WorkItem; updateData: Prisma.WorkItemUncheckedUpdateManyInput; trackFields: TrackedField[] }[] = [];
  for (const group of patchGroups.values()) {
    const groupIds = group.items.map((i) => i.id);
    // Labels are NOT written with the row. `tags` is a mirror of the
    // work_item_labels rows now, so writing the array directly would leave the
    // catalogue out of step — the label would filter but not exist to rename or
    // delete. The label helpers own both sides.
    if (group.patch.tags !== undefined) {
      if (groupIds.length === 1) await setWorkItemLabels(tx, orgId, groupIds[0], group.patch.tags, RECORDED_BY_CALLER);
      else await setLabelsForMany(tx, orgId, groupIds, group.patch.tags, RECORDED_BY_CALLER);
    }
    const destCategory = group.patch.columnKey
      ? ((await loadStatusCategories(tx, projectId, [group.patch.columnKey]))[0]?.category ?? null)
      : null;
    for (const existing of group.items) {
      changes.push({ existing, ...computeItemChange({ existing, patch: group.patch, destCategory, now }) });
    }
    await syncAssigneeSets(tx, groupIds, group.patch);
  }

  // Items whose rows take identical values are written together: a bulk move
  // is one statement per distinct outcome, not one per item.
  const groups = new Map<string, { data: Prisma.WorkItemUncheckedUpdateManyInput; ids: string[] }>();
  for (const c of changes) {
    const key = updateKey(c.updateData);
    const group = groups.get(key) ?? { data: c.updateData, ids: [] };
    group.ids.push(c.existing.id);
    groups.set(key, group);
  }
  for (const group of groups.values()) await updateWorkItemsUnchecked(tx, group.ids, group.data, RECORDED_BY_CALLER);

  const activity = changes.flatMap((c) =>
    c.trackFields.map((f) => ({
      orgId,
      workItemId: c.existing.id,
      userId: actorId,
      action: "updated",
      field: f.field,
      oldValue: f.oldVal,
      newValue: f.newVal,
    })),
  );
  // A named transition is recorded too, so history can say "Started work"
  // (design §3.6); the open workflow's moves are only the status change.
  for (const g of gate.gates) {
    if (g.transitionId) {
      activity.push({ orgId, workItemId: g.itemId, userId: actorId, action: "transitioned", field: "transition", oldValue: null, newValue: g.transitionId });
    }
  }
  if (activity.length > 0) await tx.activity.createMany({ data: activity });

  // The transition's own comments and watchers, in the same transaction.
  const comments = gate.gates.flatMap((g) => g.comments.map((content) => ({ orgId, workItemId: g.itemId, authorId: actorId, content })));
  if (comments.length > 0) await tx.comment.createMany({ data: comments });
  const watchers = gate.gates.flatMap((g) => g.watchers.map((userId) => ({ orgId, workItemId: g.itemId, userId })));
  if (watchers.length > 0) await tx.workItemWatcher.createMany({ data: watchers, skipDuplicates: true });

  // The outbox: the row writes above were RECORDED_BY_CALLER, so this records
  // one event per item from its row before and after, a transition when its
  // status moved. Tags are read back because the label helpers resolve them.
  const eventFields = [...new Set([...changes.flatMap((c) => Object.keys(c.updateData)), ...(groupPatches.some((p) => p.tags !== undefined) ? ["tags"] : [])])];
  if (eventFields.length > 0) {
    const before = allowed as unknown as Parameters<typeof changeEvents>[0];
    await recordEvents(tx, meta, changeEvents(before, await snapshotItems(tx, ids, eventFields), eventFields));
  }

  // INTERDEPENDENT RESCHEDULING (COSMOS-154). A date edit is never about one
  // item: the epic above it claims a finish date its children no longer meet,
  // and everything linked downstream is still planned against the old one. So
  // a save that moves `startDate`/`dueDate` pulls the parent chain out to the
  // envelope of its children and shifts each downstream successor by the same
  // slip. Inside this transaction, so a failure leaves NO half-moved plan.
  const scheduleCascade: CascadedItem[] = [];
  for (const { existing, updateData } of changes) {
    if (!("startDate" in updateData) && !("dueDate" in updateData)) continue;
    const afterDueValue = "dueDate" in updateData ? (updateData.dueDate as Date | null) : existing.dueDate;
    const beforeDue = existing.dueDate ? existing.dueDate.getTime() : null;
    const afterDue = afterDueValue ? afterDueValue.getTime() : null;
    // Only a SLIP travels downstream — see the planner for why pulling an
    // item in must not drag its dependents earlier with it.
    const dueShiftMs = beforeDue !== null && afterDue !== null ? afterDue - beforeDue : 0;
    scheduleCascade.push(
      ...(await cascadeSchedule(tx, {
        orgId,
        projectId,
        itemId: existing.id,
        dueShiftMs,
        userId: actorId,
        skipIds: patch.cascadeSkipIds,
        meta,
      })),
    );
  }

  effects.items = changes.map(({ existing, updateData }): ChangedItem => {
    const after = <K extends keyof WorkItem>(k: K) =>
      (k in updateData ? updateData[k as keyof typeof updateData] : existing[k]) as WorkItem[K];
    return {
      id: existing.id,
      ticketNumber: existing.ticketNumber,
      before: {
        title: existing.title,
        columnKey: existing.columnKey,
        assigneeId: existing.assigneeId,
        completedAt: existing.completedAt,
      },
      after: {
        title: after("title"),
        description: after("description"),
        columnKey: after("columnKey"),
        completedAt: after("completedAt"),
      },
    };
  });

  return { itemIds: ids, scheduleCascade, effects, denied: gate.denials };
}
