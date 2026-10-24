import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { DeletedRef, Milestone, Uuid } from "@/lib/openapi/schemas/common";
import * as E from "@/lib/openapi/schemas/enums.generated";

const params = z.object({ orgId: Uuid, projectId: Uuid, milestoneId: Uuid });

export const updateMilestone = defineRoute({
  method: "patch",
  path: "/orgs/{orgId}/projects/{projectId}/milestones/{milestoneId}",
  operationId: "updateMilestone",
  summary: "Update a milestone",
  tags: ["Milestones"],
  stability: "stable",
  scopes: ["planning:write"],
  request: {
    params,
    body: z.object({
      title: z.string().min(1).max(200).optional(),
      description: z.string().nullish(),
      dueDate: z.string().datetime().optional(),
      status: z.enum(E.MilestoneStatus).optional(),
      autoStatus: z.boolean().optional(),
      completedAt: z.string().datetime().nullish(),
      ownerId: z.string().uuid().nullish(),
      sortOrder: z.number().int().optional(),
    }),
  },
  responses: { 200: Milestone },
  errors: [400, 401, 403, 404],
});

export const deleteMilestone = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/projects/{projectId}/milestones/{milestoneId}",
  operationId: "deleteMilestone",
  summary: "Delete a milestone",
  description: "Removes the milestone and its links. The linked work items are untouched.",
  tags: ["Milestones"],
  stability: "stable",
  scopes: ["planning:write"],
  request: { params },
  responses: { 200: DeletedRef },
  errors: [400, 401, 403, 404],
});
