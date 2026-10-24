import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

// Boards on the query language (query design §12.1). Internal: the query
// language is in beta, and the predicate's shape is the compiler's.

export const compileCqlPredicate = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/cql/predicate",
  operationId: "compileCqlPredicate",
  summary: "Compile a query to a row predicate",
  description: "The compiled where for a board to judge its loaded rows with; rows it can't decide are settled by the query route's ids.",
  tags: ["Query language"],
  stability: "internal",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid }), body: z.object({}).passthrough() },
  responses: { 200: z.object({ where: z.unknown() }) },
  errors: [400, 401, 403, 404, 422, 429],
});
