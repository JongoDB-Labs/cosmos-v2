import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { SplitResult } from "@/lib/openapi/schemas/work-item-actions";

export const splitWorkItemAssignees = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}/split-assignees",
  operationId: "splitWorkItemAssignees",
  summary: "Split a work item per assignee",
  description:
    "The item keeps its first assignee. Each other assignee gets a copy with the same title, fields, labels and parent, " +
    "linked to the original as a clone. An item with fewer than two assignees is a 400.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:write"],
  request: { params: z.object({ orgId: Uuid, projectId: Uuid, itemId: Uuid }) },
  responses: { 201: SplitResult },
  errors: [400, 401, 403, 404],
});
