import { z } from "zod";
import * as E from "./enums.generated";
import { Count, NullableDateTime, Uuid, WorkItem } from "./common";
import { WorkItemAssignee, WorkItemTypeRef } from "./work-items";
import { CANCEL_NOTE_MAX, PICKABLE_CANCEL_REASONS, cancelInputError } from "@/lib/work-items/cancel";
import { WORK_ITEM_HIGHLIGHT_ORDER } from "@/lib/work-items/highlights";
import { transitionRequestSchema } from "@/lib/workflow/transition-request";

/**
 * What the work-item writes take and answer. The handlers and the change
 * service (`applyWorkItemChange`) parse with these same objects, so the
 * published spec and what the server accepts can't drift.
 */

/**
 * The fields a change may set. Every one is optional: a PUT or PATCH writes only
 * what it names, and unknown keys are ignored (as they always were). The cancel
 * check is applied by `withCancelCheck`, so this shape stays extendable.
 */
const patchFields = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().nullish(),
  workItemTypeId: z.string().uuid().nullish(),
  columnKey: z.string().nullish().describe("The status (board column) to move to."),
  assigneeId: z.string().uuid().nullable().optional().describe("The primary assignee; must be a member of the org."),
  // Multi-assign (FR 1d38496a): replaces the WHOLE set; first entry becomes the
  // primary assigneeId. When present it wins over the legacy single field.
  assigneeIds: z.array(z.string().uuid()).max(50).optional()
    .describe("Replaces the whole assignee set, the first becoming the primary. Wins over `assigneeId`."),
  priority: z.enum(E.Priority).optional(),
  intervalId: z.string().uuid().nullable().optional(),
  // COSMOS-204: the owning team, independent of the assignee. null clears it.
  teamId: z.string().uuid().nullable().optional().describe("The owning team, a team of this project. Null clears it."),
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
  cascadeSkipIds: z.array(z.string().uuid()).max(500).optional()
    .describe("Other items this same action is rescheduling by hand: the date cascade leaves them alone."),
  actualStart: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  workCategory: z.enum(E.WorkCategory).optional(),
  // The outcome of a finished or cancelled item ("Fixed", "Won't do"); free
  // text so values imported from another tracker stay as they were.
  resolution: z.string().max(200).nullable().optional(),
  // Archive / unarchive. A timestamp in, or null to bring it back.
  //
  // It rides on this route rather than getting an endpoint of its own because
  // it is gated on ITEM_UPDATE like every other field here — which is the whole
  // point: archiving is editing, not deleting, so the person who made a mess can
  // clear it up without being handed the ability to destroy anyone's work.
  archivedAt: z.string().datetime().nullable().optional().describe("A time archives the item; null brings it back."),
  // Meeting callout colour. Validated against the palette on WRITE even though
  // reads deliberately tolerate an unknown key: the column is plain TEXT for
  // forward-compatibility with a NEWER build, which is not a licence for THIS
  // build to store a typo. A rejected value is a 400 the user can see; a stored
  // one would be an invisible no-op border they could never clear from the UI.
  // `null` clears the highlight.
  highlight: z.enum(WORK_ITEM_HIGHLIGHT_ORDER).nullable().optional(),
  tags: z.array(z.string()).optional().describe("Label names; replaces the item's labels."),
  customFields: z.record(z.string(), z.unknown()).optional(),
  // Cancel with a reason (COSMOS-206). Sending a reason IS the cancel: the item
  // moves to the project's Cancelled status, which is created on first use.
  // Moving the item to any other status clears both.
  // MERGED is not accepted here: only a merge (COSMOS-207) sets it.
  cancelReason: z.enum(PICKABLE_CANCEL_REASONS).optional()
    .describe("Sending a reason cancels the item: it moves to the project's Cancelled status."),
  cancelNote: z.string().max(CANCEL_NOTE_MAX).nullish(),
});

const withCancelCheck = <T extends z.ZodType<{ cancelReason?: (typeof PICKABLE_CANCEL_REASONS)[number]; cancelNote?: string | null }>>(s: T) =>
  s.superRefine((d, ctx) => {
    const err = d.cancelReason ? cancelInputError(d.cancelReason, d.cancelNote) : null;
    if (err) ctx.addIssue({ code: "custom", path: ["cancelNote"], message: err });
  });

/** A change to one or many items: the fields to set. */
export const WorkItemPatch = withCancelCheck(patchFields).meta({ id: "WorkItemPatch" });

/** The workflow transition a change means, with the values it asked for. Not stored. */
export const TransitionRequest = transitionRequestSchema
  .describe("The transition this move takes (from `listItemTransitions`), with its `input` values. `force` needs the override permission.")
  .meta({ id: "TransitionRequest" });

/** The body of an update: the fields to set, plus the transition it takes. */
export const WorkItemUpdate = withCancelCheck(patchFields.extend({
  transition: TransitionRequest.optional(),
  boardId: z.string().uuid().optional().describe("The board the move was made on. Accepted, no longer needed."),
})).meta({ id: "WorkItemUpdate" });

/** The body of a create. */
export const WorkItemCreate = z.object({
  workItemTypeId: z.string().uuid().nullish(),
  type: z.string().nullish()
    .describe("Without `workItemTypeId`: a built-in type by name (`task`, `story`, `bug`, `epic`, `subtask`), resolved for the project's sector. Default `task`."),
  title: z.string().min(1).max(500),
  description: z.string().nullish(),
  columnKey: z.string().describe("The status (board column) it starts in."),
  assigneeId: z.string().uuid().nullable().optional(),
  // Multi-assign (FR 1d38496a): full assignee set; first entry becomes the
  // primary `assigneeId`. When present it wins over the legacy single field.
  assigneeIds: z.array(z.string().uuid()).max(50).optional()
    .describe("The whole assignee set, the first becoming the primary. Wins over `assigneeId`. Every one must be a member of the org."),
  priority: z.enum(E.Priority).default("MEDIUM"),
  intervalId: z.string().uuid().nullable().optional()
    .describe("A Story or Feature needs one in a project that has intervals."),
  // COSMOS-204: the owning team, independent of the assignee.
  teamId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  storyPoints: z.number().int().min(0).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  actualStart: z.string().datetime().nullable().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  tags: z.array(z.string()).optional().describe("Label names, matched to the org's labels (created if new)."),
  customFields: z.record(z.string(), z.unknown()).optional(),
}).meta({ id: "WorkItemCreate" });

const CreatedChildRef = z.object({
  id: Uuid,
  title: z.string(),
  columnKey: z.string(),
  workItemTypeId: Uuid,
  completedAt: NullableDateTime,
});

/** A created item, as the create answers it. */
export const WorkItemCreated = WorkItem.extend({
  children: z.array(CreatedChildRef),
  workItemType: WorkItemTypeRef,
  assignees: z.array(WorkItemAssignee),
  _count: Count("comments", "activities"),
}).meta({ id: "WorkItemCreated" });

/** An item another one's date change moved, with its dates before and after. */
export const CascadedItem = z.object({
  id: Uuid,
  reason: z.enum(["successor-shift", "parent-envelope"]),
  before: z.object({ startDate: NullableDateTime, dueDate: NullableDateTime }),
  after: z.object({ startDate: NullableDateTime, dueDate: NullableDateTime }),
}).meta({ id: "CascadedItem" });

/** An updated item, as the update answers it. */
export const WorkItemUpdated = WorkItem.extend({
  children: z.array(CreatedChildRef.extend({ ticketNumber: z.number().int() })),
  workItemType: WorkItemTypeRef.extend({ celebrateOnComplete: z.boolean() }),
  assignees: z.array(WorkItemAssignee),
  _count: Count("comments", "activities"),
  scheduleCascade: z.array(CascadedItem)
    .describe("Other items this change moved (successors and parents), with their dates before, so the move can be undone."),
}).meta({ id: "WorkItemUpdated" });

/** Most items one bulk request may name. */
export const BULK_MAX = 10_000;

/** The body of a bulk update. */
export const WorkItemBulkUpdate = z.object({
  ids: z.array(z.string().uuid()).min(1).max(BULK_MAX),
  update: z.object({
    columnKey: z.string().nullish(),
    assigneeId: z.string().uuid().nullable().optional(),
    priority: z.enum(E.Priority).optional(),
    intervalId: z.string().uuid().nullable().optional(),
    tags: z.array(z.string()).optional(),
  }),
  // The transition and its input, collected once for the whole selection.
  transition: TransitionRequest.optional(),
}).meta({ id: "WorkItemBulkUpdate" });

/** The body of a bulk delete. */
export const WorkItemBulkDelete = z.object({
  ids: z.array(z.string().uuid()).min(1).max(BULK_MAX),
}).meta({ id: "WorkItemBulkDelete" });

const FieldRef = z.union([z.object({ system: z.string() }), z.object({ custom: z.string() })]);

/** An item the workflow refused during a bulk change, and what it would take. */
export const BulkDenial = z.object({
  id: Uuid,
  code: z.string().describe("A transition problem code, e.g. `transition_not_allowed`, `transition_input_required`."),
  message: z.string(),
  transition: z.object({ id: z.string(), name: z.string(), to: z.string() }).optional(),
  fields: z.array(z.object({
    field: FieldRef,
    required: z.boolean(),
    label: z.string().optional(),
    options: z.array(z.object({ value: z.string(), label: z.string(), hint: z.string().optional() })).optional(),
  })).optional().describe("Values the transition needs: send them once as `transition.input` and retry."),
}).meta({ id: "BulkDenial" });

/** What a bulk update did. */
export const WorkItemBulkResult = z.object({
  updated: z.number().int(),
  denied: z.array(BulkDenial).describe("Items the workflow refused; the rest of the selection still moved."),
}).meta({ id: "WorkItemBulkResult" });

