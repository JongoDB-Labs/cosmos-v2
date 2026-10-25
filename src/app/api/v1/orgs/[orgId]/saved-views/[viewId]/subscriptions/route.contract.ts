import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

// Filter subscriptions (query design §12.4). Internal: the query language is
// in beta.

const params = z.object({ orgId: Uuid, viewId: Uuid });
const subscription = z.object({}).passthrough();

export const listFilterSubscriptions = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/saved-views/{viewId}/subscriptions",
  operationId: "listFilterSubscriptions",
  summary: "List a saved filter's email subscriptions",
  description: "The ones the caller made, that reach them (or their teams), or all of them for an org admin; plus the caller's teams.",
  tags: ["Saved filters"],
  stability: "internal",
  scopes: ["read"],
  request: { params },
  responses: { 200: z.object({ subscriptions: z.array(subscription), teams: z.array(z.object({ id: Uuid, name: z.string() })) }) },
  errors: [401, 403, 404],
});

export const createFilterSubscription = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/saved-views/{viewId}/subscriptions",
  operationId: "createFilterSubscription",
  summary: "Subscribe to a saved filter by email",
  description: "Yourself, or a team you're on and manage, for a filter shared with it; on a cron in an IANA time zone, at most hourly.",
  tags: ["Saved filters"],
  stability: "internal",
  scopes: ["items:write"],
  request: {
    params,
    body: z.object({
      recipient: z.union([z.object({ kind: z.literal("me") }), z.object({ kind: z.literal("team"), teamId: Uuid })]),
      cron: z.string(),
      timezone: z.string(),
      format: z.enum(["LIST", "COUNT"]).optional(),
      sendWhenEmpty: z.boolean().optional(),
      onlyChanges: z.boolean().optional(),
    }),
  },
  responses: { 201: z.object({ subscription }) },
  errors: [400, 401, 403, 404],
});
