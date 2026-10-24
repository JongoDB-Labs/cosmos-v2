import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

// Group-by and measures over a CQL query (query design §5; dashboards consume
// it). Internal: the query language is in beta.

export const aggregateWorkItems = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/work-items/aggregate",
  operationId: "aggregateWorkItems",
  summary: "Count or sum work items by up to two fields",
  description: "Groups the items a query matches, as the caller sees them: at most 25 groups per field plus Other, time fields bucketed by day, week or month.",
  tags: ["Query language"],
  stability: "internal",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid }), body: z.object({}).passthrough() },
  responses: { 200: z.object({}).passthrough() },
  errors: [400, 401, 403, 404, 422, 429],
});
