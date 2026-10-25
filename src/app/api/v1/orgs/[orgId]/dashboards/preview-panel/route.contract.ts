import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";

// The dashboard editor's panel preview (dashboards design §7.2). Internal:
// dashboards are in beta behind the query-language switch.

export const previewDashboardPanel = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/dashboards/preview-panel",
  operationId: "previewDashboardPanel",
  summary: "Compute one dashboard panel without saving it",
  description: "The panel's data as the caller sees it, or the items behind one slice of it; a panel's own failure is a 200 with `error`.",
  tags: ["Dashboards"],
  stability: "internal",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid }), body: z.object({}).passthrough() },
  responses: { 200: z.object({}).passthrough() },
  errors: [400, 401, 403, 404, 429],
});
