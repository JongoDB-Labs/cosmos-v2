import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { Comment } from "@/lib/openapi/schemas/work-items";
import { CommentWrite } from "@/lib/openapi/schemas/work-item-actions";

const params = z.object({ orgId: Uuid, projectId: Uuid, itemId: Uuid, commentId: Uuid });

export const updateWorkItemComment = defineRoute({
  method: "patch",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}/comments/{commentId}",
  operationId: "updateWorkItemComment",
  summary: "Edit a comment",
  description: "Replaces the comment's text. Only its author may edit it (403 otherwise).",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:write"],
  request: { params, body: CommentWrite },
  responses: { 200: Comment },
  errors: [400, 401, 403, 404],
});

export const deleteWorkItemComment = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}/comments/{commentId}",
  operationId: "deleteWorkItemComment",
  summary: "Delete a comment",
  description: "Removes the comment for good. Its author may, and so may a manager of the project.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:write"],
  request: { params },
  responses: { 204: null },
  errors: [401, 403, 404],
});
