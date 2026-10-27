import { z } from "zod";
import * as E from "./enums.generated";
import { IsoDateTime, NullableDateTime, Uuid } from "./common";

/**
 * The org-wide work-item search: its filter body, the rows it returns and the
 * page around them. `lib/work-items/query/parse.ts` parses requests with these
 * same schemas, and `filter.ts` takes its sort fields and page sizes from here,
 * so the published spec and the parser can't disagree.
 */

/** Sort fields the search accepts; anything else falls back to the default order. */
export const WORK_ITEM_SORT_FIELDS = ["createdAt", "updatedAt", "priority", "dueDate", "startDate", "ticketNumber"] as const;

/** Hard cap on page size: protects the DB from an unbounded scan. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

const DateRange = z
  .object({ from: z.string().optional(), to: z.string().optional() })
  .describe("Inclusive bounds, ISO dates or date-times; either end may be left open.")
  .optional();

const ParentFilter = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("any") }),
    z.object({ mode: z.literal("has_parent") }),
    z.object({ mode: z.literal("no_parent") }),
    z.object({ mode: z.literal("is"), parentIds: z.array(z.string()).default([]) }),
  ])
  .optional();

const CustomFieldFilter = z.object({
  key: z.string().min(1),
  kind: z.enum(["SELECT", "MULTI_SELECT", "CHECKBOX", "TEXT"]),
  value: z.union([z.string(), z.boolean()]),
});

/**
 * The filter object. STRICT, deliberately: a plain object strips keys it does
 * not declare, so a misspelt or unsupported filter would return an unfiltered
 * page. A filter that silently does not filter returns plausible WRONG
 * answers, so an unknown key is a 400 instead.
 */
export const WorkItemFilter = z.strictObject({
  ids: z.array(z.string().min(1)).max(MAX_PAGE_SIZE).optional().describe("Only these items."),
  archived: z.enum(["active", "only", "all"]).optional().describe("Default `active`."),
  watchedByUserId: z.string().min(1).optional().describe("Only your own user id: a watch list is personal."),
  projectIds: z.array(z.string()).optional(),
  typeIds: z.array(z.string()).optional(),
  columnKeys: z.array(z.string()).optional().describe("Status (board column) keys."),
  priorities: z.array(z.enum(E.Priority)).optional(),
  assigneeIds: z.array(z.string()).optional().describe("`unassigned` matches items with no assignee."),
  labels: z.array(z.string()).optional(),
  intervalIds: z.array(z.string()).optional().describe("`none` matches items in no interval."),
  parent: ParentFilter,
  startDate: DateRange,
  dueDate: DateRange,
  createdAt: DateRange,
  updatedAt: DateRange,
  text: z.string().optional().describe("Case-insensitive match on the title or description."),
  customFields: z.array(CustomFieldFilter).optional(),
}).meta({ id: "WorkItemFilter" });

/** The POST body: a filter, a sort and a page. Values within one field OR together; fields AND. */
export const WorkItemQuery = z.object({
  filter: WorkItemFilter.default({}),
  sort: z
    .object({
      field: z.enum(WORK_ITEM_SORT_FIELDS),
      direction: z.enum(["asc", "desc"]).default("desc"),
    })
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
}).meta({ id: "WorkItemQuery" });

const Person = z.object({ id: Uuid, displayName: z.string(), avatarUrl: z.string().nullable() });

/** One search result. */
export const WorkItemSearchRow = z.object({
  id: Uuid,
  ticketNumber: z.number().int(),
  ticketKey: z.string().describe("The project key and ticket number, e.g. `ACME-128`."),
  title: z.string(),
  columnKey: z.string().describe("The status (board column) key."),
  priority: z.enum(E.Priority),
  type: z.object({ id: Uuid, key: z.string(), name: z.string(), icon: z.string().nullable(), color: z.string().nullable() }),
  project: z.object({ id: Uuid, key: z.string(), name: z.string() }),
  assignee: Person.nullable().describe("The primary assignee."),
  assignees: z.array(Person).describe("Every assignee, the primary first."),
  reporter: Person.nullable().describe(
    "Who created the item. Still named after they are removed from the organization, so historical items stay attributable.",
  ),
  parent: z
    .object({ id: Uuid, ticketKey: z.string(), title: z.string() })
    .nullable()
    .describe("Null too when the parent is in a project you can't read."),
  intervalId: Uuid.nullable(),
  storyPoints: z.number().int().nullable(),
  tags: z.array(z.string()),
  highlight: z.string().nullable().describe("A meeting callout colour, or null."),
  archivedAt: NullableDateTime,
  startDate: NullableDateTime,
  dueDate: NullableDateTime,
  completedAt: NullableDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).meta({ id: "WorkItemSearchRow" });

/** A problem the query language found in a query. Present only on query-language searches. */
export const CqlDiagnostic = z.object({
  code: z.string().describe("Open set: new codes are added as the language grows."),
  severity: z.string(),
  message: z.string(),
  from: z.number().int(),
  to: z.number().int(),
  line: z.number().int(),
  column: z.number().int(),
  hint: z.string().optional(),
  fixes: z.array(z.unknown()).optional(),
}).meta({ id: "CqlDiagnostic" });

/** One page of search results. */
export const WorkItemSearchPage = z.object({
  data: z.array(WorkItemSearchRow),
  total: z.number().int().nullable().describe("Every match, across pages. Null only when a query-language count ran out of time."),
  totalCapped: z.boolean().optional().describe("Query-language searches: true when `total` couldn't be counted in time."),
  cql: z.string().optional().describe("Query-language searches: the query as run, normalized."),
  diagnostics: z.array(CqlDiagnostic).optional().describe("Query-language searches: warnings about the query."),
}).meta({ id: "WorkItemSearchPage" });
