import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { UnbilledReimbursables } from "@/lib/openapi/schemas/unbilled";

export const listUnbilledReimbursables = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/unbilled-reimbursables",
  operationId: "listUnbilledReimbursables",
  summary: "Unbilled reimbursable costs, by project",
  description:
    "Bills (OPEN or PAID) and APPROVED reimbursable expenses on a project that no invoice has recovered yet (never invoiced, or on a voided invoice), each priced at the markup that applies. Every project the caller can see, or the one named by `projectId` (403 if it is hidden or not this org's). Needs finance-read.",
  tags: ["Finance"],
  stability: "internal",
  // No API-key scope reaches finance: a signed-in member only.
  scopes: [],
  request: {
    params: z.object({ orgId: Uuid }),
    query: z.object({ projectId: Uuid.optional().describe("Only this project.") }),
  },
  responses: { 200: UnbilledReimbursables },
  errors: [400, 401, 403, 404],
});
