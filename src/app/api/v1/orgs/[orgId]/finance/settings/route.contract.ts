import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

const Settings = z.object({
  reimbursableMarkupPct: z
    .number()
    .describe("The org's default markup on reimbursable costs, as a percent (15 = 15%)."),
  reimbursableLines: z
    .enum(["one", "two"])
    .describe('"one": one invoice line per cost ("cost plus X%"). "two": the cost, then the markup, as two lines.'),
});

const params = z.object({ orgId: Uuid });

export const getFinanceSettings = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/finance/settings",
  operationId: "getFinanceSettings",
  summary: "Get the org's finance settings",
  tags: ["Finance"],
  stability: "internal",
  // No API-key scope reaches finance: a signed-in member only.
  scopes: [],
  request: { params },
  responses: { 200: Settings.extend({ canManage: z.boolean() }) },
  errors: [401, 403, 404],
});

export const updateFinanceSettings = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/finance/settings",
  operationId: "updateFinanceSettings",
  summary: "Change the org's finance settings",
  description: "Needs finance-manage permission. Omitted fields keep their value.",
  tags: ["Finance"],
  stability: "internal",
  scopes: [],
  request: { params, body: Settings.partial() },
  responses: { 200: Settings },
  errors: [400, 401, 403, 404],
});
