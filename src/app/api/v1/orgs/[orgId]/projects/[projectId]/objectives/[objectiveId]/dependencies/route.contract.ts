import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { ObjectiveDependency } from "@/lib/openapi/schemas/okr";

const params = z.object({ orgId: Uuid, projectId: Uuid, objectiveId: Uuid });

export const addObjectiveDependency = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/objectives/{objectiveId}/dependencies",
  operationId: "addObjectiveDependency",
  summary: "Add a dependency to an objective",
  description:
    "Records that this objective needs `dependsOnId` first. The other objective may be in another project you can read OKRs in, never another organization's. Refused if it would make a loop. Adding one that exists returns it.",
  tags: ["OKRs"],
  stability: "beta",
  scopes: ["items:write"],
  request: { params, body: z.object({ dependsOnId: Uuid }) },
  responses: { 200: ObjectiveDependency },
  errors: [400, 401, 403, 404],
});
