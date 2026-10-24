import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

export const deleteWorkflowTemplate = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/workflow-templates/{templateId}",
  operationId: "deleteWorkflowTemplate",
  summary: "Delete an org workflow template",
  description: "Projects that started from it keep their copies.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["items:write"],
  request: { params: z.object({ orgId: Uuid, templateId: Uuid }) },
  responses: { 200: z.object({ ok: z.literal(true) }) },
  errors: [401, 403, 404],
});
