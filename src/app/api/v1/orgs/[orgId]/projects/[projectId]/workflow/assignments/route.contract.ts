import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { MigrationMap, projectParams } from "../../workflows/route.contract";

export const assignProjectWorkflow = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/projects/{projectId}/workflow/assignments",
  operationId: "assignProjectWorkflow",
  summary: "Choose the workflow a type (or the project) follows",
  description:
    "`workItemTypeId` null is the project default. `workflowId` null returns it to the open workflow " +
    "(for a type: to the project default). Items whose status the newly governing workflow doesn't use " +
    "need `migrationMap` (409 `migration_map_required` lists them); they then move in the background.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["items:write"],
  request: {
    params: projectParams,
    body: z.object({ workItemTypeId: Uuid.nullable(), workflowId: Uuid.nullable(), migrationMap: MigrationMap.optional() }),
  },
  responses: { 200: z.object({ migrationMap: MigrationMap }) },
  errors: [400, 401, 403, 404, 409, 422],
});
