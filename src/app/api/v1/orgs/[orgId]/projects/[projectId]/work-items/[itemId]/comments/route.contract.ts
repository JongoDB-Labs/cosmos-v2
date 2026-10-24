import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { WorkItemComment } from "@/lib/openapi/schemas/work-items";
import { CommentWrite } from "@/lib/openapi/schemas/work-item-actions";

/** Shared with `createWorkItemCommentById`. */
export const CREATE_COMMENT_DESCRIPTION =
  "Posts a comment as the caller. Members it mentions as `<@userId>` are notified, and so is the item's assignee unless they wrote it.";

export const listWorkItemComments = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}/comments",
  operationId: "listWorkItemComments",
  summary: "List a work item's comments",
  description:
    "The whole thread, oldest first, with each author's name and whether the caller may edit or delete each comment. " +
    "`listWorkItemCommentsById` reads the same thread without the project id.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid, projectId: Uuid, itemId: Uuid }) },
  responses: { 200: z.array(WorkItemComment) },
  errors: [400, 401, 403, 404],
});

export const createWorkItemComment = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}/comments",
  operationId: "createWorkItemComment",
  summary: "Comment on a work item",
  description: `${CREATE_COMMENT_DESCRIPTION} \`createWorkItemCommentById\` does the same without the project id.`,
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:write"],
  request: { params: z.object({ orgId: Uuid, projectId: Uuid, itemId: Uuid }), body: CommentWrite },
  responses: { 201: WorkItemComment },
  errors: [400, 401, 403, 404],
});
