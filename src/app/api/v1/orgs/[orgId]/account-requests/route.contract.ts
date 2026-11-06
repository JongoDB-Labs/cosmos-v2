import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";

// The queue of people asking this org for an account.
//
// Internal, and `scopes: []`, which refuses every bearer token. Deciding who
// gets an account is a human admin action: an API key must not be able to
// read the queue or mint an account from it. Nothing is taken away by that —
// the capability is new, so no key minted earlier could reach it.

const params = z.object({ orgId: z.string().uuid() });

export const listAccountRequests = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/account-requests",
  operationId: "listAccountRequests",
  summary: "List account requests",
  description:
    "The requests people have submitted to join this org, newest first. "
    + "Pending by default; pass status to see decided ones.",
  tags: ["Members"],
  stability: "internal",
  scopes: [],
  request: { params, query: z.object({ status: z.enum(["PENDING", "APPROVED", "DENIED"]).optional() }) },
  responses: { 200: z.string() },
  errors: [401, 403, 404],
});
