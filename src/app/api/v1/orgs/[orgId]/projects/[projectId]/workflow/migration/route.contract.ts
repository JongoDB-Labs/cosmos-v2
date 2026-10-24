import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { projectParams } from "../../workflows/route.contract";

export const getWorkflowMigration = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/workflow/migration",
  operationId: "getWorkflowMigration",
  summary: "Items still to move after a publish or assignment",
  description:
    "Per (workflow, type, status): items in a status their workflow no longer uses, and where they go. " +
    "`to` null means no map says, and a person must move them. Empty when nothing is pending.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["read"],
  request: { params: projectParams },
  responses: {
    200: z.array(
      z.object({
        workflowId: Uuid,
        workItemTypeId: Uuid.nullable(),
        from: z.string(),
        to: z.string().nullable(),
        items: z.number().int(),
      }),
    ),
  },
  errors: [401, 403, 404],
});
