import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { WorkItemDetail } from "@/lib/openapi/schemas/work-items";
import { WorkItemUpdate, WorkItemUpdated } from "@/lib/openapi/schemas/work-item-write";
import { UPDATE_DESCRIPTION } from "../../projects/[projectId]/work-items/[itemId]/route.contract";

const params = z.object({ orgId: Uuid, itemId: Uuid });

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
  request: { params },
  responses: { 200: WorkItemDetail },
  errors: [400, 401, 403, 404],
});

export const updateWorkItemById = defineRoute({
  method: "patch",
  path: "/orgs/{orgId}/work-items/{itemId}",
  operationId: "updateWorkItemById",
  summary: "Update a work item by its id",
  description: `The same as \`updateWorkItem\`, without the project in the path. ${UPDATE_DESCRIPTION}`,
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:write"],
  request: { params, body: WorkItemUpdate },
  responses: { 200: WorkItemUpdated },
  errors: [400, 401, 403, 404, 409, 422],
});

/** PUT on this path is the same partial update as PATCH (the app sends PUT). */
export const replaceWorkItemById = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/work-items/{itemId}",
  operationId: "replaceWorkItemById",
  summary: "Update a work item by its id (PUT)",
  description: "The same partial update as `updateWorkItemById`, sent as PUT: only the fields the body names change.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:write"],
  request: { params, body: WorkItemUpdate },
  responses: { 200: WorkItemUpdated },
  errors: [400, 401, 403, 404, 409, 422],
});

export const deleteWorkItemById = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/work-items/{itemId}",
  operationId: "deleteWorkItemById",
  summary: "Delete a work item by its id",
  description: "The same as `deleteWorkItem`, without the project in the path.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:delete"],
  request: { params },
  responses: { 204: null },
  errors: [401, 403, 404],
});
