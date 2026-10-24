import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { TimeEntry } from "@/lib/openapi/schemas/time";
import * as E from "@/lib/openapi/schemas/enums.generated";

const params = z.object({ orgId: Uuid, entryId: Uuid });

export const getTimeEntry = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/time-entries/{entryId}",
  operationId: "getTimeEntry",
  summary: "Get a time entry",
  tags: ["Time"],
  stability: "stable",
  scopes: ["time:read"],
  request: { params },
  responses: { 200: TimeEntry },
  errors: [400, 401, 403, 404],
});

export const updateTimeEntry = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/time-entries/{entryId}",
  operationId: "updateTimeEntry",
  summary: "Update a time entry",
  description:
    "Partial update of your own DRAFT entry (admins may edit any). 409 once its timesheet is " +
    "submitted, or when the new date falls in a submitted one. Every edit is kept as a revision.",
  tags: ["Time"],
  stability: "stable",
  scopes: ["time:write"],
  request: {
    params,
    body: z.object({
      date: z.string().nullish(),
      hours: z.number().positive().optional(),
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
  responses: { 200: TimeEntry },
  errors: [400, 401, 403, 404, 409],
});
