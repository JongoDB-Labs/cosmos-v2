import { z } from "zod";
import { Count, NullableDateTime, NullableUuid, Uuid, WorkItem } from "./common";
import { WorkItemAssignee, WorkItemTypeRef } from "./work-items";

/**
 * What the actions on one work item take and answer: its comments, watching
 * it, duplicating it, merging it into another and splitting it per assignee.
 * The handlers parse with these same objects.
 */

/** Most characters one comment may hold. */
export const COMMENT_MAX = 10_000;

/** The body of a new comment, or of an edit to one. */
export const CommentWrite = z.object({
  content: z.string().min(1).max(COMMENT_MAX)
    .describe("The text. Mention a member as `<@userId>`: they are notified."),
}).meta({ id: "CommentWrite" });

/** Whether the caller watches an item, and how many people do. */
export const WorkItemWatch = z.object({
  watching: z.boolean(),
  watcherCount: z.number().int(),
}).meta({ id: "WorkItemWatch" });

/** Where watching an item, or stopping, left the caller. */
export const WatchState = z.object({ watching: z.boolean() }).meta({ id: "WatchState" });

/** The body of a duplicate, which may be left out. */
export const DuplicateRequest = z.object({
  withChildren: z.boolean().optional().describe("Also copy the item's direct sub-items under the copy. Default false."),
}).meta({ id: "DuplicateRequest" }).optional();

const ChildRef = z.object({
  id: Uuid,
  title: z.string(),
  ticketNumber: z.number().int(),
  columnKey: z.string(),
  workItemTypeId: Uuid,
});

/** A copy, as the duplicate answers it. */
export const WorkItemDuplicate = WorkItem.extend({
  children: z.array(ChildRef).describe("The copied sub-items, when `withChildren` was set."),
  workItemType: WorkItemTypeRef,
  _count: Count("comments", "activities"),
}).meta({ id: "WorkItemDuplicate" });

/** The body of a merge. */
export const MergeRequest = z.object({
  intoId: Uuid.describe("The item that survives. It must be in the same project."),
}).meta({ id: "MergeRequest" });

/** One side of a merge, as it stands afterwards. */
export const MergedItem = WorkItem.extend({
  children: z.array(ChildRef.extend({ completedAt: NullableDateTime })),
  workItemType: WorkItemTypeRef,
  assignees: z.array(WorkItemAssignee),
}).meta({ id: "MergedItem" });

/** What a merge did. */
export const MergeResult = z.object({
  merged: MergedItem.describe("The duplicate, now cancelled as merged."),
  into: MergedItem.describe("The item that survived."),
  moved: z.object({
    comments: z.number().int(),
    timeEntries: z.number().int(),
    children: z.number().int(),
    attachments: z.number().int(),
    links: z.number().int(),
  }).describe("How much moved from the duplicate to the survivor."),
}).meta({ id: "MergeResult" });

/** What a split did. */
export const SplitResult = z.object({
  keptAssigneeId: Uuid.describe("The one assignee the original keeps."),
  copies: z.array(z.object({
    id: Uuid,
    ticketNumber: z.number().int(),
    title: z.string(),
    assigneeId: NullableUuid,
  })).describe("One copy per other assignee, each linked to the original as a clone."),
}).meta({ id: "SplitResult" });
