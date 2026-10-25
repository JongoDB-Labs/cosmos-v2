import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { WorkItemComment } from "@/lib/openapi/schemas/work-items";
import { CommentWrite } from "@/lib/openapi/schemas/work-item-actions";
import { CREATE_COMMENT_DESCRIPTION } from "../../../projects/[projectId]/work-items/[itemId]/comments/route.contract";

export const listWorkItemCommentsById = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/work-items/{itemId}/comments",
  operationId: "listWorkItemCommentsById",
  summary: "List a work item's comments by its id",
  description: "The same as `listWorkItemComments`, without the project in the path.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid, itemId: Uuid }) },
  responses: { 200: z.array(WorkItemComment) },
  errors: [400, 401, 403, 404],
});

export const createWorkItemCommentById = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/work-items/{itemId}/comments",
  operationId: "createWorkItemCommentById",
  summary: "Comment on a work item by its id",
  description: `${CREATE_COMMENT_DESCRIPTION} The same as \`createWorkItemComment\`, without the project in the path.`,
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:write"],
  request: { params: z.object({ orgId: Uuid, itemId: Uuid }), body: CommentWrite },
  responses: { 201: WorkItemComment },
  errors: [400, 401, 403, 404],
});
