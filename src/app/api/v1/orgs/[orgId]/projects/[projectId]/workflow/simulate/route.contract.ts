import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { Definition, projectParams } from "../../workflows/route.contract";

export const simulateWorkflow = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/workflow/simulate",
  operationId: "simulateWorkflow",
  summary: "Which transitions an actor would have on an item",
  description:
    "Every transition out of the item's current status, under the live workflow or under `definition` " +
    "(a draft), for the caller or for another member: available, needs input, blocked by its checks, " +
    "restricted or hidden, with why. Nothing is written.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["read"],
  request: {
    params: projectParams,
    body: z.object({ itemId: Uuid, actorUserId: Uuid.optional(), definition: Definition.optional() }),
  },
  responses: {
    200: z.object({
      status: z.string(),
      inWorkflow: z.boolean(),
      transitions: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          to: z.string(),
          toCategory: z.string().nullable(),
          outcome: z.enum(["available", "needs_input", "blocked", "restricted", "hidden"]),
          reasons: z.array(z.string()),
          input: z.array(z.record(z.string(), z.unknown())),
        }),
      ),
    }),
  },
  errors: [400, 401, 403, 404, 422],
});
