import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { WorkItemDetail } from "@/lib/openapi/schemas/work-items";
import { WorkItemUpdate, WorkItemUpdated } from "@/lib/openapi/schemas/work-item-write";

const params = z.object({ orgId: Uuid, projectId: Uuid, itemId: Uuid });

/** Shared by the project-path update and the by-id PATCH/PUT. */
export const UPDATE_DESCRIPTION =
  "Changes only the fields the body names. A status change runs the project's workflow: send `transition` " +
  "(from `listItemTransitions`) with any `input` it asks for, or the move is refused (409/422 with what's " +
  "needed). Assignees must be members of the org (422 `assignee_not_in_org`). Moving the dates can move " +
  "successors and parents: they come back in `scheduleCascade`.";

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
  request: { params },
  responses: { 200: WorkItemDetail },
  errors: [400, 401, 403, 404],
});

export const updateWorkItem = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}",
  operationId: "updateWorkItem",
  summary: "Update a work item",
  description: `${UPDATE_DESCRIPTION} \`updateWorkItemById\` does the same without the project id.`,
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:write"],
  request: { params, body: WorkItemUpdate },
  responses: { 200: WorkItemUpdated },
  errors: [400, 401, 403, 404, 409, 422],
});

export const deleteWorkItem = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}",
  operationId: "deleteWorkItem",
  summary: "Delete a work item",
  description: "Deletes the item for good, with its comments and history. To set it aside instead, archive it (`archivedAt`).",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:delete"],
  request: { params },
  responses: { 204: null },
  errors: [401, 403, 404],
});
