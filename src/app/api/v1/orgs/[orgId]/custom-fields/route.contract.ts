import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { CustomField, Uuid } from "@/lib/openapi/schemas/common";

export const listCustomFields = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/custom-fields",
  operationId: "listCustomFields",
  summary: "List custom fields",
  description: "Field definitions; a work item stores its values in `customFields` by `key`.",
  tags: ["Configuration"],
  stability: "stable",
  scopes: ["read"],
  request: {
    params: z.object({ orgId: Uuid }),
    query: z.object({ projectId: Uuid.optional().describe("Only this project's fields.") }),
  },
  responses: { 200: z.array(CustomField) },
  errors: [400, 401, 403, 404],
});
