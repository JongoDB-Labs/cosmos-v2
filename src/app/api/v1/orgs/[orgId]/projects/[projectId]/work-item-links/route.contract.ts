import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid, firstOf } from "@/lib/openapi/schemas/common";
import * as E from "@/lib/openapi/schemas/enums.generated";
import { CreatedWorkItemLink, WorkItemLinkRow } from "@/lib/openapi/schemas/links";

const params = z.object({ orgId: Uuid, projectId: Uuid });

export const listWorkItemLinks = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/work-item-links",
  operationId: "listWorkItemLinks",
  summary: "List a project's work-item links",
  description: "Every link between the project's work items, oldest first. `item` narrows to the links one item is on, at either end.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["read"],
  request: {
    params,
    query: z.object({
      // As before contracts: blank means no filter, and a repeated one reads
      // as its first value (searchParams.get()).
      item: firstOf(z.union([Uuid, z.literal("")]).optional())
        .describe("A work item id: only the links it is the source or target of."),
    }),
  },
  responses: { 200: z.array(WorkItemLinkRow) },
  errors: [400, 401, 403, 404],
});

export const createWorkItemLink = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/projects/{projectId}/work-item-links",
  operationId: "createWorkItemLink",
  summary: "Link two work items",
  description:
    "Both items must be in this project, and an item can't link to itself. " +
    "A 409 means the same link already exists, or a directed link (BLOCKS, PREDECESSOR, …) would make a dependency cycle.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["items:write"],
  request: {
    params,
    body: z.object({
      sourceItemId: Uuid,
      targetItemId: Uuid,
      type: z.enum(E.LinkType),
    }),
  },
  responses: { 201: CreatedWorkItemLink },
  errors: [400, 401, 403, 404, 409],
});
