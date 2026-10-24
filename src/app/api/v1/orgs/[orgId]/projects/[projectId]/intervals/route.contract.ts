import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { IntervalWithCount, Uuid } from "@/lib/openapi/schemas/common";
import * as E from "@/lib/openapi/schemas/enums.generated";

const params = z.object({ orgId: Uuid, projectId: Uuid });

export const listIntervals = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/intervals",
  operationId: "listIntervals",
  summary: "List intervals",
  description: "The project's sprints, phases and Program Increments, newest first, each with its item count.",
  tags: ["Intervals"],
  stability: "stable",
  scopes: ["read"],
  request: {
    params,
    query: z.object({ status: z.enum(E.SprintStatus).optional().describe("Only intervals in this state.") }),
  },
  responses: { 200: z.array(IntervalWithCount) },
  errors: [400, 401, 403, 404],
});

export const createInterval = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/intervals",
  operationId: "createInterval",
  summary: "Create an interval",
  description:
    "A sprint (the default kind) may sit inside a Program Increment via `parentId`; a Program " +
    "Increment is always top-level.",
  tags: ["Intervals"],
  stability: "stable",
  scopes: ["planning:write"],
  request: {
    params,
    body: z.object({
      name: z.string().min(1).max(100),
      goal: z.string().nullish(),
      startDate: z.string().datetime(),
      endDate: z.string().datetime(),
      intervalKind: z.enum(E.IntervalKind).default("SPRINT"),
      // Program Increment this interval belongs to (a PI interval id). Only meaningful for
      // sprints; a PI is top-level so it never carries a parent.
      parentId: z.string().uuid().nullish(),
    }),
  },
  responses: { 201: IntervalWithCount },
  errors: [400, 401, 403, 404],
});
