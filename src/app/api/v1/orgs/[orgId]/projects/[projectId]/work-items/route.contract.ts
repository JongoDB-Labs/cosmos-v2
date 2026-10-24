import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { QueryId, Uuid, firstOf } from "@/lib/openapi/schemas/common";
import * as E from "@/lib/openapi/schemas/enums.generated";
import { WorkItemListRow } from "@/lib/openapi/schemas/work-items";

const params = z.object({ orgId: Uuid, projectId: Uuid });

export const listProjectWorkItems = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/projects/{projectId}/work-items",
  operationId: "listProjectWorkItems",
  summary: "List a project's work items",
  description:
    "Every work item in the project, in board order (the board, backlog and timeline read this). " +
    "Archived items are left out unless `archived` asks for them. The filters combine with AND. " +
    "For search across projects, paging and sorting, use the org-wide work-item search.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["read"],
  request: {
    params,
    query: z.object({
      // As before contracts: a blank filter is no filter, a repeated one reads
      // as its first value, and `archived` takes any string (anything but
      // `only` / `all` means "active only").
      archived: firstOf(z.string().optional())
        .describe("`only`: just archived items; `all`: archived and active. Anything else, or none: active only."),
      includeArchived: firstOf(z.string().optional()).describe("`1`: the same as `archived=all` (the alias that shipped first)."),
      workItemTypeId: firstOf(QueryId.optional()),
      priority: firstOf(z.union([z.enum(E.Priority), z.literal("")]).optional()).describe("Blank means no filter."),
      columnKey: firstOf(z.string().optional()).describe("A board column (status) key."),
      assigneeId: firstOf(QueryId.optional()).describe("The primary assignee."),
      intervalId: firstOf(QueryId.optional()),
      parentId: firstOf(QueryId.optional()),
      search: firstOf(z.string().optional()).describe("Case-insensitive match on the title."),
    }),
  },
  responses: { 200: z.array(WorkItemListRow) },
  errors: [400, 401, 403, 404],
});
