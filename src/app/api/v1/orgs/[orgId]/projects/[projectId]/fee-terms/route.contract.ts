import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

const MarkupPct = z
  .number()
  .nullable()
  .describe("This project's markup on reimbursable costs, as a percent (15 = 15%). Null uses the org's default.");

const FeeTerms = z.object({
  markupPct: MarkupPct,
  effectiveMarkup: z
    .object({ pct: z.number(), source: z.enum(["project", "org"]) })
    .describe("The percent a bill on this project gets unless it sets its own, and which level set it."),
});

const params = z.object({ orgId: Uuid, projectId: Uuid });

export const getProjectFeeTerms = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/fee-terms",
  operationId: "getProjectFeeTerms",
  summary: "Get a project's fee terms",
  tags: ["Finance"],
  stability: "internal",
  // No API-key scope reaches finance: a signed-in member only.
  scopes: [],
  request: { params },
  responses: { 200: FeeTerms.extend({ canManage: z.boolean() }) },
  errors: [401, 403, 404],
});

export const updateProjectFeeTerms = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/projects/{projectId}/fee-terms",
  operationId: "updateProjectFeeTerms",
  summary: "Change a project's fee terms",
  description: "Needs finance-manage permission. A null markup goes back to the org's default.",
  tags: ["Finance"],
  stability: "internal",
  scopes: [],
  request: { params, body: z.object({ markupPct: MarkupPct }) },
  responses: { 200: FeeTerms },
  errors: [400, 401, 403, 404],
});
