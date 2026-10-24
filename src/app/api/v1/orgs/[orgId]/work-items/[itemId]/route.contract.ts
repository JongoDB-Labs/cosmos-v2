import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { WorkItemDetail } from "@/lib/openapi/schemas/work-items";

export const getWorkItemById = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/work-items/{itemId}",
  operationId: "getWorkItemById",
  summary: "Get a work item by its id",
  description:
    "The same as `getWorkItem`, without the project in the path: an item's id is unique in the org. " +
    "The caller still needs to be able to read the item's project.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid, itemId: Uuid }) },
  responses: { 200: WorkItemDetail },
  errors: [400, 401, 403, 404],
});
