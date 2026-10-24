import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { projectParams } from "../../workflows/route.contract";

const Category = z.enum(["TODO", "IN_PROGRESS", "DONE", "CANCELLED"]);

export const listStatusConflicts = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/workflow/conflicts",
  operationId: "listStatusConflicts",
  summary: "Statuses whose boards disagree on their category",
  description:
    "Found when statuses moved from board columns to the project (each a workflow.backfill_conflict audit row). " +
    "Until one is resolved, a disagreeing lane keeps its own category.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["read"],
  request: { params: projectParams },
  responses: {
    200: z.array(
      z.object({
        statusId: Uuid,
        key: z.string(),
        statusCategory: Category,
        boards: z.array(z.object({ boardId: Uuid, boardName: z.string(), category: Category })),
      }),
    ),
  },
  errors: [401, 403, 404],
});

export const resolveStatusConflict = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/workflow/conflicts",
  operationId: "resolveStatusConflict",
  summary: "Resolve a status's category conflict",
  description: "Keep the status's category (`take: \"status\"`) or take a board's; every lane then follows the status.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["items:write"],
  request: { params: projectParams, body: z.object({ key: z.string().min(1), take: z.union([z.literal("status"), Category]) }) },
  responses: { 200: z.object({ category: Category }) },
  errors: [400, 401, 403, 404],
});
