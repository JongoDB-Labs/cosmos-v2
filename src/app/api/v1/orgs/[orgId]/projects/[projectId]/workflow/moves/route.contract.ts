import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

const MoveMap = z
  .record(z.string(), z.array(z.string()))
  .nullable()
  .describe("Status key → the status keys a move from it may lead to. Null: any status to any status.");

export const getWorkflowMoves = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/workflow/moves",
  operationId: "getWorkflowMoves",
  summary: "Where the caller could move a project's items",
  description:
    "For a board to dim the statuses a card can't move to before it is dropped. A move whose " +
    "restriction depends on the item counts as possible; the move itself is still checked.",
  tags: ["Workflows"],
  stability: "internal",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid, projectId: Uuid }) },
  responses: { 200: z.object({ default: MoveMap, byType: z.record(z.string(), MoveMap) }) },
  errors: [401, 403, 404],
});
