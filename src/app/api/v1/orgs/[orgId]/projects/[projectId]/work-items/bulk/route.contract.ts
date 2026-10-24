import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { WorkItemBulkDelete, WorkItemBulkResult, WorkItemBulkUpdate } from "@/lib/openapi/schemas/work-item-write";

const params = z.object({ orgId: Uuid, projectId: Uuid });

export const bulkUpdateWorkItems = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/bulk",
  operationId: "bulkUpdateWorkItems",
  summary: "Update many work items",
  description:
    "Applies one change (status, assignee, priority, interval, labels) to up to 10,000 items of the project, " +
    "as editing each would. A status change runs the workflow per item: the items it refuses come back in " +
    "`denied`, with what each needs, and the rest still move. Needs the bulk-edit permission or managing the project.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:write"],
  request: { params, body: WorkItemBulkUpdate },
  responses: { 200: WorkItemBulkResult },
  errors: [400, 401, 403, 404, 422],
});

export const bulkDeleteWorkItems = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/bulk",
  operationId: "bulkDeleteWorkItems",
  summary: "Delete many work items",
  description: "Deletes up to 10,000 items of the project for good. Ids that aren't in the project are skipped.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:delete"],
  request: { params, body: WorkItemBulkDelete },
  responses: { 204: null },
  errors: [400, 401, 403, 404],
});
