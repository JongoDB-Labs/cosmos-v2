import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

const Row = z.object({
  userId: Uuid,
  displayName: z.string().nullable(),
  isSelf: z.boolean(),
  requested: z.number().describe("Hours awaiting a decision."),
  approved: z.number().describe("Approved hours still to come this year."),
  used: z.number().describe("Approved hours already taken."),
  allowance: z.number().nullable(),
  allowanceSource: z.enum(["person", "org"]).nullable(),
  remaining: z.number().nullable().describe("allowance − used − approved. Negative when overdrawn."),
});

export const getTimeOffSummary = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/time-off/summary",
  operationId: "getTimeOffSummary",
  summary: "Time-off balances for a year",
  description:
    "Requested, approved, used and remaining time off for each person whose time the caller may read: " +
    "themselves, plus their reports, or everyone with org-wide time access.",
  tags: ["Time"],
  stability: "internal",
  scopes: ["time:read"],
  request: {
    params: z.object({ orgId: Uuid }),
    query: z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }),
  },
  responses: {
    200: z.object({
      year: z.number().int(),
      countedKinds: z.array(z.string()),
      defaultAllowance: z.number().nullable(),
      canManage: z.boolean(),
      rows: z.array(Row),
    }),
  },
  errors: [400, 401, 403, 404],
});
