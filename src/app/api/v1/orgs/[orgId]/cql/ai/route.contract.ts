import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

// "Ask AI to build a filter" (query design §12.3). Internal: the query
// language is in beta.

export const buildCqlWithAi = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/cql/ai",
  operationId: "buildCqlWithAi",
  summary: "Turn a sentence into a CQL query",
  description: "Returns the query and its diagnostics for the caller to check; nothing is run.",
  tags: ["Query language"],
  stability: "internal",
  scopes: ["read"],
  request: {
    params: z.object({ orgId: Uuid }),
    body: z.object({ prompt: z.string().min(1).max(500), tz: z.string().max(64).optional() }),
  },
  responses: { 200: z.object({ cql: z.string(), diagnostics: z.array(z.object({}).passthrough()) }) },
  errors: [400, 401, 403, 404, 429],
});
