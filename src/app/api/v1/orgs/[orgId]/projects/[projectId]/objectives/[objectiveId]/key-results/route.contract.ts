import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { KeyResult } from "@/lib/openapi/schemas/okr";
import * as E from "@/lib/openapi/schemas/enums.generated";

export const createKeyResult = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/objectives/{objectiveId}/key-results",
  operationId: "createKeyResult",
  summary: "Add a key result",
  tags: ["OKRs"],
  stability: "stable",
  scopes: ["items:write"],
  request: {
    params: z.object({ orgId: Uuid, projectId: Uuid, objectiveId: Uuid }),
    body: z.object({
      title: z.string().min(1).max(200),
      startValue: z.number().default(0),
      currentValue: z.number().default(0),
      targetValue: z.number().default(100),
      unit: z.string().max(40).optional(),
      lowerIsBetter: z.boolean().default(false),
      status: z.enum(E.KeyResultStatus).default("IN_PROGRESS"),
    }),
  },
  responses: { 201: KeyResult },
  errors: [400, 401, 403, 404],
});
