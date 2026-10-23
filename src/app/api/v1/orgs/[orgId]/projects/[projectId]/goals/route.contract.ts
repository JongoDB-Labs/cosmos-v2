import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { Goal } from "@/lib/openapi/schemas/goals";
import * as E from "@/lib/openapi/schemas/enums.generated";

const params = z.object({ orgId: Uuid, projectId: Uuid });

export const listGoals = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/goals",
  operationId: "listGoals",
  summary: "List goals",
  description: "In their manual order, with links. An AUTO goal's progress is rolled up from its linked items and objectives.",
  tags: ["Goals & KPIs"],
  stability: "stable",
  scopes: ["read"],
  request: { params },
  responses: { 200: z.array(Goal) },
  errors: [400, 401, 403, 404],
});

export const createGoal = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/goals",
  operationId: "createGoal",
  summary: "Create a goal",
  tags: ["Goals & KPIs"],
  stability: "stable",
  scopes: ["planning:write"],
  request: {
    params,
    body: z.object({
      title: z.string().min(1).max(200),
      description: z.string().nullish(),
      status: z.enum(E.GoalStatus).default("PLANNED"),
      targetDate: z.string().datetime().nullish(),
      progressMode: z.enum(E.GoalProgressMode).default("MANUAL"),
      ownerId: z.string().uuid().nullish(),
    }),
  },
  responses: { 200: Goal },
  errors: [400, 401, 403, 404, 409, 422],
  idempotency: true,
});
