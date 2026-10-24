import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import { WorkItemSearchPage } from "@/lib/openapi/schemas/work-item-query";
import { workItemSearchQuery } from "./search/route.contract";

export const listWorkItems = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/work-items",
  operationId: "listWorkItems",
  summary: "List work items across projects",
  description:
    "The org-wide work-item collection: the same search, filters and results as `searchWorkItems`, " +
    "at the collection's own path. Results come from every project you can read; a project-scoped " +
    "API key reads only its projects. An unrecognised parameter is a 400.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid }), query: workItemSearchQuery },
  responses: { 200: WorkItemSearchPage },
  errors: [400, 401, 403, 404, 429],
});
