import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import * as E from "@/lib/openapi/schemas/enums.generated";

export const updateTimeOffAllowance = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/time-off/allowances",
  operationId: "updateTimeOffAllowance",
  summary: "Set a time-off allowance",
  description:
    "With `userId` and `year`: that person's allowance for that year (null removes it, so the org default applies). " +
    "Without `userId`: the org default, and which kinds of leave draw on it. Needs org-wide time access and approval rights.",
  tags: ["Time"],
  stability: "internal",
  // No API-key scope grants it: a signed-in admin only.
  scopes: [],
  request: {
    params: z.object({ orgId: Uuid }),
    body: z.object({
      userId: Uuid.optional(),
      year: z.number().int().min(2000).max(2100).optional(),
      hours: z.number().min(0).max(2000).nullable().optional(),
      countedKinds: z.array(z.enum(E.TimeOffKind)).min(1).optional(),
    }),
  },
  responses: { 200: z.object({ ok: z.literal(true) }) },
  errors: [400, 401, 403, 404],
});
