import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { WatchState, WorkItemWatch } from "@/lib/openapi/schemas/work-item-actions";

const params = z.object({ orgId: Uuid, projectId: Uuid, itemId: Uuid });

export const getWorkItemWatch = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}/watch",
  operationId: "getWorkItemWatch",
  summary: "Whether you watch a work item",
  description: "Whether the caller watches the item, and how many people do.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["read"],
  request: { params },
  responses: { 200: WorkItemWatch },
  errors: [400, 401, 403, 404],
});

export const watchWorkItem = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}/watch",
  operationId: "watchWorkItem",
  summary: "Watch a work item",
  description:
    "Follows the item, so it shows among the caller's watched tickets. Anyone who can read the item may, so `read` " +
    "suffices: it changes only the caller's own subscription. Watching twice is not an error.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["read"],
  request: { params },
  responses: { 200: WatchState },
  errors: [400, 401, 403, 404],
});

export const unwatchWorkItem = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}/watch",
  operationId: "unwatchWorkItem",
  summary: "Stop watching a work item",
  description: "Stops following the item. Not watching it already is not an error.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["read"],
  request: { params },
  responses: { 200: WatchState },
  errors: [400, 401, 403, 404],
});
