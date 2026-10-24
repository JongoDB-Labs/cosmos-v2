import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid, WorkItemType } from "@/lib/openapi/schemas/common";

export const listWorkItemTypes = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/work-item-types",
  operationId: "listWorkItemTypes",
  summary: "List work-item types",
  description: "Built-in types first, then the organization's own. Use an `id` as a work item's `workItemTypeId`.",
  tags: ["Configuration"],
  stability: "stable",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid }) },
  responses: { 200: z.array(WorkItemType) },
  errors: [400, 401, 403, 404],
});
