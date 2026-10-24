import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { DeletedRef, Uuid } from "@/lib/openapi/schemas/common";
import { Goal } from "@/lib/openapi/schemas/goals";
import * as E from "@/lib/openapi/schemas/enums.generated";

const params = z.object({ orgId: Uuid, projectId: Uuid, goalId: Uuid });

export const updateGoal = defineRoute({
  method: "patch",
  path: "/orgs/{orgId}/projects/{projectId}/goals/{goalId}",
  operationId: "updateGoal",
  summary: "Update a goal",
  tags: ["Goals & KPIs"],
  stability: "stable",
  scopes: ["planning:write"],
  request: {
    params,
    body: z.object({
      title: z.string().min(1).max(200).optional(),
      description: z.string().nullish(),
      status: z.enum(E.GoalStatus).optional(),
      progress: z.number().int().min(0).max(100).optional(),
      progressMode: z.enum(E.GoalProgressMode).optional(),
      targetDate: z.string().datetime().nullish(),
      ownerId: z.string().uuid().nullish(),
      sortOrder: z.number().int().optional(),
    }),
  },
  responses: { 200: Goal },
  errors: [400, 401, 403, 404],
});

export const deleteGoal = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/goals/{goalId}",
  operationId: "deleteGoal",
  summary: "Delete a goal",
  tags: ["Goals & KPIs"],
  stability: "stable",
  scopes: ["planning:write", "items:delete"],
  request: { params },
  responses: { 200: DeletedRef },
  errors: [400, 401, 403, 404],
});
