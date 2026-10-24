import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

// Starred saved filters (query design §10.4). Internal while the query
// language is in beta.

const params = z.object({ orgId: Uuid, viewId: Uuid });

export const starSavedView = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/saved-views/{viewId}/favorite",
  operationId: "starSavedView",
  summary: "Star a saved filter",
  description: "Star a filter the caller can see, optionally at a position in their sidebar list.",
  tags: ["Saved filters"],
  stability: "internal",
  scopes: ["items:write"],
  request: { params, body: z.object({ sortOrder: z.number().int().min(0).max(10_000).optional() }) },
  responses: { 200: z.object({ favorite: z.literal(true), sortOrder: z.number().int() }) },
  errors: [400, 401, 404],
});

export const unstarSavedView = defineRoute({
  method: "delete",
  path: "/orgs/{orgId}/saved-views/{viewId}/favorite",
  operationId: "unstarSavedView",
  summary: "Unstar a saved filter",
  tags: ["Saved filters"],
  stability: "internal",
  scopes: ["items:write"],
  request: { params },
  responses: { 204: null },
  errors: [401, 404],
});
