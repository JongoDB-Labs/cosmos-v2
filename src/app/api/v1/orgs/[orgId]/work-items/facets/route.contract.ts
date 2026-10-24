import { defineRoute } from "@/lib/openapi/contract";
import { z } from "zod";
import { Uuid } from "@/lib/openapi/schemas/common";
import { WorkItemFacets } from "@/lib/openapi/schemas/work-items";

export const getWorkItemFacets = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/work-items/facets",
  operationId: "getWorkItemFacets",
  summary: "Get work-item filter options",
  description:
    "The values the work-item filters can take across the projects the caller can read: projects, types, statuses " +
    "(also per project), members, labels in use and intervals. A caller who can read no project gets empty lists.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["read"],
  request: { params: z.object({ orgId: Uuid }) },
  responses: { 200: WorkItemFacets },
  errors: [400, 401, 403, 404],
});
