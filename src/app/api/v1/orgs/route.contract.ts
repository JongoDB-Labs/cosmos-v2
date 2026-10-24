import { defineRoute } from "@/lib/openapi/contract";
import { z } from "zod";
import { MyOrg } from "@/lib/openapi/schemas/identity";

export const listMyOrgs = defineRoute({
  method: "get",
  path: "/orgs",
  operationId: "listMyOrgs",
  summary: "List my organizations",
  description: "Organizations you belong to. A token is bound to one, so it lists only that one. Use an `id` as `{orgId}`.",
  tags: ["Account"],
  stability: "stable",
  scopes: [],
  request: {},
  responses: { 200: z.array(MyOrg) },
  errors: [401, 404],
});
