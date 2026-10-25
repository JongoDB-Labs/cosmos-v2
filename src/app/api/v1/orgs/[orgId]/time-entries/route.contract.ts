import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { QueryDate, Uuid } from "@/lib/openapi/schemas/common";
import { TimeEntry } from "@/lib/openapi/schemas/time";
import * as E from "@/lib/openapi/schemas/enums.generated";

export const listTimeEntries = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/time-entries",
  operationId: "listTimeEntries",
  summary: "List time entries",
  description:
    "Your own entries, plus those of people you supervise, or everyone's with org-wide time access. " +
    "Asking for someone outside that is a 403, not an empty list. Newest first.",
  tags: ["Time"],
  stability: "stable",
  scopes: ["time:read"],
  request: {
    params: z.object({ orgId: Uuid }),
    query: z.object({
      // "" means unset (an empty `?userId=`), as it always has.
      userId: z.union([Uuid, z.literal("")]).optional(),
      projectId: Uuid.optional(),
      status: z.enum(E.TimeEntryStatus).optional(),
      billableType: z.enum(E.BillableType).optional(),
      startDate: QueryDate.optional(),
      endDate: QueryDate.optional(),
    }),
  },
  responses: {
    200: z.object({ data: z.array(TimeEntry), total: z.number().int() }).meta({ id: "TimeEntryList" }),
  },
  errors: [400, 401, 403, 404],
});

export const createTimeEntry = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/time-entries",
  operationId: "createTimeEntry",
  summary: "Log time",
  description: "Logs time for the caller, filed into the timesheet for its date.",
  tags: ["Time"],
  stability: "stable",
  scopes: ["time:write"],
  request: {
    params: z.object({ orgId: Uuid }),
    body: z.object({
      date: z.string(),
      hours: z.number().positive(),
      rate: z.number().optional(),
      client: z.string().nullish(),
      projectId: z.string().uuid().nullish(),
      workItemId: z.string().uuid().nullish(),
      clinId: z.string().uuid().nullish(),
      description: z.string().nullish(),
      billableType: z.enum(E.BillableType).optional(),
      tags: z.array(z.string()).optional(),
    }),
  },
  responses: { 201: TimeEntry },
  errors: [400, 401, 403, 404, 409, 422],
  idempotency: true,
});
