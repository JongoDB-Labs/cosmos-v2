import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { KeyResultCheckin } from "@/lib/openapi/schemas/okr";
import * as E from "@/lib/openapi/schemas/enums.generated";

const params = z.object({ orgId: Uuid, projectId: Uuid, krId: Uuid });

export const listCheckins = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/key-results/{krId}/checkins",
  operationId: "listCheckins",
  summary: "List key-result check-ins",
  description: "Newest first.",
  tags: ["OKRs"],
  stability: "stable",
  scopes: ["read"],
  request: { params },
  responses: { 200: z.array(KeyResultCheckin) },
  errors: [400, 401, 403, 404],
});

export const createCheckin = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/key-results/{krId}/checkins",
  operationId: "createCheckin",
  summary: "Check in on a key result",
  description:
    "Records a value, confidence and RAG status. The key result takes the value as its current " +
    "value (GREEN → on track, YELLOW/RED → at risk), and the objective's progress is recomputed.",
  tags: ["OKRs"],
  stability: "stable",
  scopes: ["items:write"],
  request: {
    params,
    body: z.object({
      value: z.number(),
      confidence: z.number().int().min(0).max(100),
      rag: z.enum(E.RagStatus),
      note: z.string().max(2000).nullish(),
      blockers: z.string().max(2000).nullish(),
    }),
  },
  responses: { 201: KeyResultCheckin },
  errors: [400, 401, 403, 404, 409, 422],
  idempotency: true,
});
