import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

// Saved filters v2 (query design §10). Internal while the query language is
// in beta: the shapes follow the CQL contract and may still change.

const params = z.object({ orgId: Uuid, viewId: Uuid });

export const getSavedView = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/saved-views/{viewId}",
  operationId: "getSavedView",
  summary: "Get a saved filter",
  description: "A saved filter the caller can see, with its query printed for them (names they can't read show as restricted).",
  tags: ["Saved filters"],
  stability: "internal",
  scopes: ["read"],
  request: { params },
  responses: { 200: z.object({}).passthrough() },
  errors: [401, 404],
});

export const updateSavedView = defineRoute({
  method: "patch",
  path: "/orgs/{orgId}/saved-views/{viewId}",
  operationId: "updateSavedView",
  summary: "Update a saved filter",
  description: "Change a saved filter's name, description, query, visibility or editors. Owners, editors and org admins only.",
  tags: ["Saved filters"],
  stability: "internal",
  scopes: ["items:write"],
  request: { params, body: z.object({}).passthrough() },
  responses: { 200: z.object({}).passthrough() },
  errors: [400, 401, 403, 404, 409],
});
