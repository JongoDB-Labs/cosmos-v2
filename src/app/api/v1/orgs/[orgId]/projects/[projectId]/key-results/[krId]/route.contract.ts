import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { DeletedRef, Uuid } from "@/lib/openapi/schemas/common";
import { KeyResult } from "@/lib/openapi/schemas/okr";
import * as E from "@/lib/openapi/schemas/enums.generated";

const params = z.object({ orgId: Uuid, projectId: Uuid, krId: Uuid });

export const updateKeyResult = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/projects/{projectId}/key-results/{krId}",
  operationId: "updateKeyResult",
  summary: "Update a key result",
  description: "Partial update; the objective's progress is recomputed from its key results.",
  tags: ["OKRs"],
  stability: "stable",
  scopes: ["items:write"],
  request: {
    params,
    body: z.object({
      currentValue: z.number().optional(),
      targetValue: z.number().optional(),
      startValue: z.number().optional(),
      title: z.string().min(1).max(200).optional(),
      unit: z.string().max(40).optional(),
      lowerIsBetter: z.boolean().optional(),
      status: z.enum(E.KeyResultStatus).optional(),
    }),
  },
  responses: { 200: KeyResult },
  errors: [400, 401, 403, 404],
});

export const deleteKeyResult = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/key-results/{krId}",
  operationId: "deleteKeyResult",
  summary: "Delete a key result",
  tags: ["OKRs"],
  stability: "stable",
  scopes: ["items:delete"],
  request: { params },
  responses: { 200: DeletedRef },
  errors: [400, 401, 403, 404],
});
