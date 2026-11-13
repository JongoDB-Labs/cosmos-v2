import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { DeletedRef, Uuid } from "@/lib/openapi/schemas/common";

const params = z.object({ orgId: Uuid, projectId: Uuid, objectiveId: Uuid, dependsOnId: Uuid });

export const removeObjectiveDependency = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/objectives/{objectiveId}/dependencies/{dependsOnId}",
  operationId: "removeObjectiveDependency",
  summary: "Remove a dependency from an objective",
  description: "Answers with the id of the objective it no longer depends on; 404 if it didn't depend on it.",
  tags: ["OKRs"],
  stability: "beta",
  scopes: ["items:write"],
  request: { params },
  responses: { 200: DeletedRef },
  errors: [400, 401, 403, 404],
});
