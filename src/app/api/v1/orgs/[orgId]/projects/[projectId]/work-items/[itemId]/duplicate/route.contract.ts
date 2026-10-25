import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { DuplicateRequest, WorkItemDuplicate } from "@/lib/openapi/schemas/work-item-actions";

export const duplicateWorkItem = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/work-items/{itemId}/duplicate",
  operationId: "duplicateWorkItem",
  summary: "Duplicate a work item",
  description:
    "Creates a copy titled \"Copy of …\" in the same status, under the same parent, with the same fields and labels " +
    "and a new ticket number. Comments and history aren't copied. The body may be left out.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:write"],
  request: { params: z.object({ orgId: Uuid, projectId: Uuid, itemId: Uuid }), body: DuplicateRequest },
  responses: { 201: WorkItemDuplicate },
  errors: [400, 401, 403, 404],
});
