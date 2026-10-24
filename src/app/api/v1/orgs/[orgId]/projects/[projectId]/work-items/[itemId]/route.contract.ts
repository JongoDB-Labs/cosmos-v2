import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { WorkItemDetail } from "@/lib/openapi/schemas/work-items";

export const getWorkItem = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}",
  operationId: "getWorkItem",
  summary: "Get a work item",
  description:
    "The item with its type, parent, children, assignees and interval, its first 50 comments and its 50 latest changes. " +
    "`getWorkItemById` reads the same item without its project id.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid, projectId: Uuid, itemId: Uuid }) },
  responses: { 200: WorkItemDetail },
  errors: [400, 401, 403, 404],
});
