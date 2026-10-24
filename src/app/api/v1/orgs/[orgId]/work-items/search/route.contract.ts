import { z } from "zod";
import { defineRoute } from "@/lib/openapi/contract";
import { Uuid } from "@/lib/openapi/schemas/common";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  WORK_ITEM_SORT_FIELDS,
  WorkItemQuery,
  WorkItemSearchPage,
} from "@/lib/openapi/schemas/work-item-query";

const params = z.object({ orgId: Uuid });

// The handler reads these itself (parseSearchParams), as before contracts:
// multi-value filters take repeated keys or a comma list, out-of-range paging
// is clamped and unrecognised values are ignored. So every parameter accepts
// any string here; the descriptions say what each one reads.
const one = z.string().optional();
const many = z.union([z.string(), z.array(z.string())]).optional();

/** The GET search's query parameters, shared with the bare collection path. */
export const workItemSearchQuery = z.object({
  project: many.describe("Project ids. Repeat the parameter or separate with commas."),
  type: many.describe("Work-item type ids."),
  status: many.describe("Status (board column) keys."),
  priority: many.describe("CRITICAL, HIGH, MEDIUM or LOW; other values are ignored."),
  assignee: many.describe("User ids; `unassigned` matches items with no assignee."),
  label: many,
  interval: many.describe("Interval ids; `none` matches items in no interval."),
  cf: many.describe("A custom-field match, `key~KIND~value` (KIND is SELECT, MULTI_SELECT, CHECKBOX or TEXT). Repeat for several."),
  parent: one.describe("`has_parent` or `no_parent`."),
  parentId: many.describe("Children of these items."),
  archived: one.describe("`only`: just archived items; `all`: archived and active. Anything else, or none: active only."),
  includeArchived: one.describe("`1`: the same as `archived=all`."),
  startFrom: one, startTo: one, dueFrom: one, dueTo: one,
  createdFrom: one, createdTo: one, updatedFrom: one, updatedTo: one,
  text: one.describe("Case-insensitive match on the title or description."),
  watchedByMe: one.describe("Any value: only items you watch."),
  sortField: one.describe(`One of ${WORK_ITEM_SORT_FIELDS.join(", ")}. Anything else: the default order.`),
  sortDir: one.describe("`asc`; anything else is descending."),
  page: one.describe("From 1."),
  pageSize: one.describe(`Default ${DEFAULT_PAGE_SIZE}, at most ${MAX_PAGE_SIZE}; larger values are clamped.`),
});

const SEARCH_RULES =
  "Results come from every project you can read; a project-scoped API key reads only its projects. " +
  "Filters on different fields combine with AND, and the values of one field with OR. " +
  "A parameter the search doesn't recognise is a 400 rather than being ignored, so a misspelt filter " +
  "can't return an unfiltered page; its `issues` name the parameters.";

export const searchWorkItems = defineRoute({
  method: "get",
  path: "/orgs/{orgId}/work-items/search",
  operationId: "searchWorkItems",
  summary: "Search work items across projects",
  description: `${SEARCH_RULES} For filters that don't fit in a URL, POST the same search as JSON.`,
  tags: ["Work items"],
  stability: "stable",
  scopes: ["read"],
  request: { params, query: workItemSearchQuery },
  responses: { 200: WorkItemSearchPage },
  errors: [400, 401, 403, 404, 429],
});

export const searchWorkItemsByFilter = defineRoute({
  method: "post",
  path: "/orgs/{orgId}/work-items/search",
  operationId: "searchWorkItemsByFilter",
  summary: "Search work items with a JSON filter",
  description:
    "The work-item search with the filter as a JSON body. Results come from every project you can read; " +
    "a project-scoped API key reads only its projects. An unknown filter key is a 400. " +
    "`watchedByUserId` may only be your own user id.",
  tags: ["Work items"],
  stability: "stable",
  scopes: ["read"],
  request: { params, body: WorkItemQuery },
  responses: { 200: WorkItemSearchPage },
  errors: [400, 401, 403, 404],
});
