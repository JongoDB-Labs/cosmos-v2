import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Milestone, MilestoneWithProgress, Uuid } from "@/lib/openapi/schemas/common";

const params = z.object({ orgId: Uuid, projectId: Uuid });

export const listMilestones = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/milestones",
  operationId: "listMilestones",
  summary: "List milestones",
  description: "The project's milestones by due date, with progress from their linked work items.",
  tags: ["Milestones"],
  stability: "stable",
  scopes: ["read"],
  request: { params },
  responses: { 200: z.array(MilestoneWithProgress) },
  errors: [400, 401, 403, 404],
});

export const createMilestone = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/milestones",
  operationId: "createMilestone",
  summary: "Create a milestone",
  description: "With `autoStatus` (the default), status and date follow the work items linked to it.",
  tags: ["Milestones"],
  stability: "stable",
  scopes: ["planning:write"],
  request: {
    params,
    body: z.object({
      title: z.string().min(1).max(200),
      description: z.string().nullish(),
      dueDate: z.string().datetime(),
      ownerId: z.string().uuid().nullish(),
      autoStatus: z.boolean().optional(),
    }),
  },
  responses: { 200: Milestone },
  errors: [400, 401, 403, 404, 409, 422],
  idempotency: true,
});
