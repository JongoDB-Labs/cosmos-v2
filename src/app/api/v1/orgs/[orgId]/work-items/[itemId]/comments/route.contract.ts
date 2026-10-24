import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { WorkItemComment } from "@/lib/openapi/schemas/work-items";

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
