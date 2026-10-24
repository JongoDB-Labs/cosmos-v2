import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

export const deleteWorkItemLink = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/work-item-links/{linkId}",
  operationId: "deleteWorkItemLink",
  summary: "Remove a work-item link",
  description: "Unlinks the two items; neither item changes.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:write"],
  request: { params: z.object({ orgId: Uuid, projectId: Uuid, linkId: Uuid }) },
  responses: { 204: null },
  errors: [400, 401, 403, 404],
});
