import { z } from "zod";
import * as E from "./enums.generated";
import { IsoDateTime, Json, NullableDateTime, NullableUuid, Uuid, WorkItem } from "./common";

/**
 * Work items as the read routes return them: the row plus the relations each
 * route includes. Response schemas strip, so a relation missing here is one the
 * API stops returning; these mirror the routes' `include`s exactly.
 */

/** The work-item type a row points at, as lists and detail views show it. */
export const WorkItemTypeRef = z.object({
  id: Uuid,
  key: z.string().describe("Stable key, e.g. `software.bug`."),
  name: z.string(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
}).meta({ id: "WorkItemTypeRef" });

export const WorkItemParentRef = z.object({
  id: Uuid,
  title: z.string(),
  ticketNumber: z.number().int(),
  workItemTypeId: Uuid,
}).meta({ id: "WorkItemParentRef" });

export const WorkItemChildRef = z.object({
  id: Uuid,
  title: z.string(),
  columnKey: z.string(),
  ticketNumber: z.number().int(),
  workItemTypeId: Uuid,
  completedAt: NullableDateTime,
}).meta({ id: "WorkItemChildRef" });

/** One of the item's assignees, in assignment order; the first is `assigneeId`. */
export const WorkItemAssignee = z.object({
  userId: Uuid,
  user: z.object({ id: Uuid, displayName: z.string(), avatarUrl: z.string().nullable() }),
}).meta({ id: "WorkItemAssignee" });

export const WorkItemIntervalRef = z.object({
  id: Uuid,
  name: z.string(),
  number: z.number().int(),
  status: z.enum(E.SprintStatus),
}).meta({ id: "WorkItemIntervalRef" });

/** A row of a project's work-item list (the board, backlog and timeline read this). */
export const WorkItemListRow = WorkItem.extend({
  parent: WorkItemParentRef.nullable(),
  children: z.array(WorkItemChildRef),
  workItemType: WorkItemTypeRef,
  assignees: z.array(WorkItemAssignee),
}).meta({ id: "WorkItemListRow" });

export const Comment = z.object({
  id: Uuid,
  orgId: Uuid,
  workItemId: NullableUuid,
  subjectType: z.string().nullable().describe("What a non-work-item comment is on (a PM register entry, a document, …)."),
  subjectId: NullableUuid,
  authorId: Uuid,
  content: z.string().describe("User-authored text."),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  parentId: NullableUuid.describe("The top-level comment this replies to."),
  visibility: z.enum(E.CommentVisibility),
  kind: z.enum(E.CommentKind),
  meta: Json.describe("Kind-specific detail: a status change's from/to, a merge's source."),
  editedAt: NullableDateTime,
  deletedAt: NullableDateTime,
  deletedById: NullableUuid,
  hiddenAt: NullableDateTime,
  hiddenById: NullableUuid,
  hiddenReason: z.string().nullable(),
  originSubjectId: NullableUuid.describe("Set when a merge moved the comment here."),
  classification: z.enum(E.ClassificationLevel).nullable(),
}).meta({ id: "Comment" });

/** A comment as the work item's thread shows it: who wrote it, and what the caller may do. */
export const WorkItemComment = Comment.extend({
  authorName: z.string().nullable(),
  authorAvatarUrl: z.string().nullable(),
  canEdit: z.boolean().describe("The caller wrote it."),
  canDelete: z.boolean().describe("The caller wrote it, or manages the project."),
}).meta({ id: "WorkItemComment" });

export const Activity = z.object({
  id: Uuid,
  orgId: Uuid,
  workItemId: NullableUuid,
  subjectType: z.string().nullable(),
  subjectId: NullableUuid,
  userId: Uuid.describe("Who made the change."),
  action: z.string().describe("e.g. `created`, `updated`, `moved`."),
  field: z.string().nullable(),
  oldValue: z.string().nullable().describe("The value before, for the item fields the history shows values for (title, status, priority, assignee, dates, …); null for any other field."),
  newValue: z.string().nullable().describe("The value after; null like `oldValue`."),
  createdAt: IsoDateTime,
}).meta({ id: "Activity" });

/** One work item with its relations, its first 50 comments and its 50 latest changes. */
export const WorkItemDetail = WorkItemListRow.extend({
  comments: z.array(Comment).describe("Oldest first, at most 50. The full thread is `listWorkItemComments`."),
  activities: z.array(Activity).describe("Newest first, at most 50."),
  interval: WorkItemIntervalRef.nullable(),
}).meta({ id: "WorkItemDetail" });

const StatusOption = z.object({ key: z.string(), name: z.string(), category: z.string() });

/** Everything the org-wide Issues filters offer, limited to the projects the caller can read. */
export const WorkItemFacets = z.object({
  projects: z.array(z.object({
    id: Uuid,
    key: z.string(),
    name: z.string(),
    archived: z.boolean(),
    sector: z.string().nullable(),
  })),
  types: z.array(WorkItemTypeRef),
  statuses: z.array(StatusOption).describe("Every status key across those projects, first name seen."),
  statusesByProject: z.record(z.string(), z.array(StatusOption))
    .describe("Per project: the statuses its own boards have, keyed by project id."),
  members: z.array(z.object({ id: Uuid, displayName: z.string(), avatarUrl: z.string().nullable() })),
  labels: z.array(z.string()).describe("Labels in use, sorted."),
  intervals: z.array(z.object({
    id: Uuid,
    name: z.string(),
    number: z.number().int(),
    projectId: Uuid,
    status: z.enum(E.SprintStatus),
  })),
  managedProjectIds: z.array(Uuid).describe("The projects the caller manages."),
}).meta({ id: "WorkItemFacets" });

/** For schemas.test: every entity names every column of its model. */
export const entities = {
  Comment: { schema: Comment, model: "Comment", omitted: {} },
  Activity: { schema: Activity, model: "Activity", omitted: {} },
};
