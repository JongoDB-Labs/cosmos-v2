import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";

// Approve an account request, minting an invitation.
//
// Internal with `scopes: []`, so no bearer token reaches it. Creating an
// account is a human admin decision; an API key must never be able to make
// one. See the collection's contract for why that takes nothing away.

const params = z.object({ orgId: z.string().uuid(), requestId: z.string().uuid() });

export const approveAccountRequest = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/account-requests/{requestId}/approve",
  operationId: "approveAccountRequest",
  summary: "Approve an account request",
  description:
    "Mints an invitation for the requested address through the same path an "
    + "admin-sent invitation uses. signInMethod chooses per request: `oauth` "
    + "sends an invitation link, `email_password` provisions a temporary "
    + "password — except on an address that already has an account, where a "
    + "credential is never set and the invitation link is sent instead.",
  tags: ["Members"],
  stability: "internal",
  scopes: [],
  request: { params },
  responses: { 200: z.string() },
  errors: [400, 401, 403, 404, 409],
});
