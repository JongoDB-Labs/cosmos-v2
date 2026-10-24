import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { IsoDateTime, Uuid } from "@/lib/openapi/schemas/common";

export const listAutomationRuns = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/automations/{ruleId}/runs",
  operationId: "listAutomationRuns",
  summary: "A rule's recent runs: its audit log",
  description: "Newest first, at most `limit` (default 50). `before` pages back from a run's `createdAt`.",
  tags: ["Automations"],
  stability: "internal",
  scopes: ["items:write"],
  request: {
    params: z.object({ orgId: Uuid, ruleId: Uuid }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), before: IsoDateTime.optional() }),
  },
  responses: {
    200: z.array(
      z.object({
        id: Uuid,
        ruleRevision: z.number().int(),
        eventId: z.string().nullable(),
        correlationId: Uuid,
        depth: z.number().int(),
        status: z.enum(["SUCCESS", "NO_MATCH", "PARTIAL", "FAILED", "LOOP", "THROTTLED", "SKIPPED_SELF"]),
        itemsMatched: z.number().int(),
        actions: z.unknown(),
        durationMs: z.number().int(),
        createdAt: IsoDateTime,
      }),
    ),
  },
  errors: [401, 403, 404],
});
