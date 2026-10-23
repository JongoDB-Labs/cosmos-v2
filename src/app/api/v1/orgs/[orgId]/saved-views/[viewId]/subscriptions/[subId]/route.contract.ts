import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

// One filter subscription (query design §12.4). Internal: the query language
// is in beta.

const params = z.object({ orgId: Uuid, viewId: Uuid, subId: Uuid });

export const updateFilterSubscription = defineRoute({
  method: "patch",
  path: "/orgs/{orgId}/saved-views/{viewId}/subscriptions/{subId}",
  operationId: "updateFilterSubscription",
  summary: "Change, pause or resume a filter subscription",
  tags: ["Saved filters"],
  stability: "internal",
  scopes: ["items:write"],
  request: {
    params,
    body: z.object({
      cron: z.string().optional(),
      timezone: z.string().optional(),
      format: z.enum(["LIST", "COUNT"]).optional(),
      sendWhenEmpty: z.boolean().optional(),
      onlyChanges: z.boolean().optional(),
      enabled: z.boolean().optional(),
    }),
  },
  responses: { 200: z.object({ subscription: z.object({}).passthrough() }) },
  errors: [400, 401, 403, 404],
});

export const deleteFilterSubscription = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/saved-views/{viewId}/subscriptions/{subId}",
  operationId: "deleteFilterSubscription",
  summary: "Remove a filter subscription",
  tags: ["Saved filters"],
  stability: "internal",
  scopes: ["items:write"],
  request: { params },
  responses: { 204: null },
  errors: [401, 403, 404],
});
