import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Label, Uuid } from "@/lib/openapi/schemas/common";

export const listLabels = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/labels",
  operationId: "listLabels",
  summary: "List labels",
  description: "The organization's labels by name, each with how many work items carry it.",
  tags: ["Configuration"],
  stability: "stable",
  scopes: ["read"],
  request: {
    params: z.object({ orgId: Uuid }),
    query: z.object({ projectId: Uuid.optional().describe("Count only this project's items.") }),
  },
  responses: { 200: z.array(Label) },
  errors: [400, 401, 403, 404],
});
