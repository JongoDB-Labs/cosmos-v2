import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { WorkItemComment } from "@/lib/openapi/schemas/work-items";

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
