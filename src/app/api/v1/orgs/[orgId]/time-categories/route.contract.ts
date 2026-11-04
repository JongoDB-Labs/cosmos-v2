import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

const Categories = z
  .array(z.string())
  .describe("The org's internal time categories, in display order. Empty means internal time is not categorised.");

const params = z.object({ orgId: Uuid });

export const getTimeCategories = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/time-categories",
  operationId: "getTimeCategories",
  summary: "Get the org's internal time categories",
  tags: ["Time"],
  stability: "internal",
  scopes: ["time:read"],
  request: { params },
  responses: { 200: z.object({ categories: Categories, canManage: z.boolean() }) },
  errors: [401, 403, 404],
});

export const updateTimeCategories = defineRoute({
  method: "put",
  path: "/orgs/{orgId}/time-categories",
  operationId: "updateTimeCategories",
  summary: "Change the org's internal time categories",
  description: "Needs org-settings permission. Existing entries keep the category they were logged with.",
  tags: ["Time"],
  stability: "internal",
  // No API-key scope grants org settings: a signed-in admin only.
  scopes: [],
  request: { params, body: z.object({ categories: z.array(z.string()) }) },
  responses: { 200: z.object({ categories: Categories }) },
  errors: [400, 401, 403, 404],
});
