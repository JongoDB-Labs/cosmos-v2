import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";

// Deny an account request. The row is kept: a denial is a decision, not a gap.
//
// Internal with `scopes: []` for the same reason as its sibling — deciding
// who does NOT get an account is equally a human admin action.

const params = z.object({ orgId: z.string().uuid(), requestId: z.string().uuid() });

export const denyAccountRequest = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/account-requests/{requestId}/deny",
  operationId: "denyAccountRequest",
  summary: "Deny an account request",
  description:
    "Marks the request denied and records who decided. The row is retained so "
    + "the decision stays attributable, and the address is free to ask again.",
  tags: ["Members"],
  stability: "internal",
  scopes: [],
  request: { params },
  responses: { 200: z.string() },
  errors: [401, 403, 404, 409],
});
