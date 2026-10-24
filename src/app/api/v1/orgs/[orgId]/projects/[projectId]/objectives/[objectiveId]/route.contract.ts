import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { DeletedRef, Uuid } from "@/lib/openapi/schemas/common";
import { Objective } from "@/lib/openapi/schemas/okr";
import * as E from "@/lib/openapi/schemas/enums.generated";

const params = z.object({ orgId: Uuid, projectId: Uuid, objectiveId: Uuid });

export const getObjective = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/objectives/{objectiveId}",
  operationId: "getObjective",
  summary: "Get an objective",
  tags: ["OKRs"],
  stability: "stable",
  scopes: ["read"],
  request: { params },
  responses: { 200: Objective },
  errors: [400, 401, 403, 404],
});

export const updateObjective = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/projects/{projectId}/objectives/{objectiveId}",
  operationId: "updateObjective",
  summary: "Update an objective",
  description: "Partial update. `parentId` may not create an alignment loop.",
  tags: ["OKRs"],
  stability: "stable",
  scopes: ["items:write"],
  request: {
    params,
    body: z.object({
      title: z.string().min(1).max(200).optional(),
      description: z.string().nullish(),
      period: z.string().nullish(),
      status: z.enum(E.ObjectiveStatus).optional(),
      parentId: z.string().uuid().nullable().optional(),
      targetDate: z.string().datetime().nullable().optional(),
      intervalId: z.string().uuid().nullable().optional(),
      committed: z.boolean().optional(),
    }),
  },
  responses: { 200: Objective },
  errors: [400, 401, 403, 404],
});

export const deleteObjective = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/objectives/{objectiveId}",
  operationId: "deleteObjective",
  summary: "Delete an objective",
  description: "Deletes the objective and its key results.",
  tags: ["OKRs"],
  stability: "stable",
  scopes: ["items:delete"],
  request: { params },
  responses: { 200: DeletedRef },
  errors: [400, 401, 403, 404],
});
