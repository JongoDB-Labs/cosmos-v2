import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { IntervalDetail, IntervalWithCount, Uuid } from "@/lib/openapi/schemas/common";
import * as E from "@/lib/openapi/schemas/enums.generated";

const params = z.object({ orgId: Uuid, projectId: Uuid, intervalId: Uuid });

export const getInterval = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/intervals/{intervalId}",
  operationId: "getInterval",
  summary: "Get an interval",
  description: "One interval with its work items, in board order.",
  tags: ["Intervals"],
  stability: "stable",
  scopes: ["read"],
  request: { params },
  responses: { 200: IntervalDetail },
  errors: [400, 401, 403, 404],
});

export const updateInterval = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/projects/{projectId}/intervals/{intervalId}",
  operationId: "updateInterval",
  summary: "Update an interval",
  description:
    "Partial update. Setting `status` to `ACTIVE` starts it (409 while another sprint in the " +
    "project is active, and it also starts its Program Increment). A Program Increment can't be " +
    "started by hand, and completes only once every interval inside it has.",
  tags: ["Intervals"],
  stability: "stable",
  scopes: ["planning:write"],
  request: {
    params,
    body: z.object({
      name: z.string().min(1).max(100).optional(),
      goal: z.string().nullish(),
      startDate: z.string().datetime().nullish(),
      endDate: z.string().datetime().nullish(),
      status: z.enum(E.SprintStatus).optional(),
      // Program Increment to nest this sprint under (a PI interval id), or null to
      // detach it back to top level. Validated same-project + must be a PI.
      parentId: z.string().uuid().nullable().optional(),
    }),
  },
  responses: { 200: IntervalWithCount },
  errors: [400, 401, 403, 404, 409],
});
