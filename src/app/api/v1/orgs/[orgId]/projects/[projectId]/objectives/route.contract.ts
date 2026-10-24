import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { Objective, ObjectiveWithProgress } from "@/lib/openapi/schemas/okr";
import * as E from "@/lib/openapi/schemas/enums.generated";

const params = z.object({ orgId: Uuid, projectId: Uuid });

export const listObjectives = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/objectives",
  operationId: "listObjectives",
  summary: "List objectives",
  description: "The project's objectives in their manual order, with key results, progress and health.",
  tags: ["OKRs"],
  stability: "stable",
  scopes: ["read"],
  request: { params },
  responses: { 200: z.array(ObjectiveWithProgress) },
  errors: [400, 401, 403, 404],
});

export const createObjective = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/objectives",
  operationId: "createObjective",
  summary: "Create an objective",
  description: "Appended to the end of the project's order. `intervalId` must be an interval of this project.",
  tags: ["OKRs"],
  stability: "stable",
  scopes: ["items:write"],
  request: {
    params,
    body: z.object({
      title: z.string().min(1).max(200),
      description: z.string().nullish(),
      period: z.string().nullish(),
      status: z.enum(E.ObjectiveStatus).default("ACTIVE"),
      parentId: z.string().uuid().nullish(),
      // The timebox this objective belongs to — a PI for a PI Objective, a sprint
      // for a sprint-level one. Validated to be an interval of THIS project.
      intervalId: z.string().uuid().nullish(),
      // SAFe committed vs uncommitted (stretch). Defaults to committed.
      committed: z.boolean().default(true),
    }),
  },
  responses: { 200: Objective },
  errors: [400, 401, 403, 404],
});

export const reorderObjectives = defineRoute({
  method: "patch",
  path: "/orgs/{orgId}/projects/{projectId}/objectives",
  operationId: "reorderObjectives",
  summary: "Reorder objectives",
  description: "Sets the manual order: each listed objective's position becomes its index. Ids from other projects are ignored.",
  tags: ["OKRs"],
  stability: "stable",
  scopes: ["items:write"],
  request: { params, body: z.object({ orderedIds: z.array(z.string().uuid()).min(1) }) },
  responses: { 200: z.object({ reordered: z.number().int() }).meta({ id: "ReorderResult" }) },
  errors: [400, 401, 403, 404],
});
