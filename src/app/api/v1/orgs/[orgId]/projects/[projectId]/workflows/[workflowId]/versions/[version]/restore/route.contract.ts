import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Issue, workflowParams } from "../../../../route.contract";

export const restoreWorkflowVersion = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/workflows/{workflowId}/versions/{version}/restore",
  operationId: "restoreWorkflowVersion",
  summary: "Draft an old version's definition",
  description: "The draft becomes that version's definition; publishing it makes the next version, so history stays linear.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["items:write"],
  request: { params: workflowParams.extend({ version: z.coerce.number().int().positive() }) },
  responses: { 200: z.object({ version: z.number().int(), issues: z.array(Issue) }) },
  errors: [400, 401, 403, 404],
});
