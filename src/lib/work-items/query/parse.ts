/**
 * Validation + parsing for the cross-project work-item query. Turns untrusted
 * input (URL search params OR a JSON body) into a typed `WorkItemFilter` +
 * sort + pagination. Pure (no DB) so it is unit-testable.
 *
 * Two entry points:
 *   - `parseSearchParams` — for a GET with `?project=a&project=b&priority=HIGH…`
 *   - `workItemQuerySchema` — a zod schema for a POST JSON body (complex filters)
 */
import { z } from "zod";
import { Priority } from "@prisma/client";
import {
  type WorkItemFilter,
  type WorkItemSort,
  type WorkItemSortField,
  type CustomFieldFilter,
  type CustomFieldFilterKind,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  SORT_FIELDS,
} from "./filter";

const dateRangeSchema = z
  .object({ from: z.string().optional(), to: z.string().optional() })
  .optional();

const parentSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("any") }),
    z.object({ mode: z.literal("has_parent") }),
    z.object({ mode: z.literal("no_parent") }),
    z.object({ mode: z.literal("is"), parentIds: z.array(z.string()).default([]) }),
  ])
  .optional();

const customFieldFilterSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(["SELECT", "MULTI_SELECT", "CHECKBOX", "TEXT"]),
  value: z.union([z.string(), z.boolean()]),
});

/** zod schema for the filter object (shared by GET-normalised + POST bodies). */
export const workItemFilterSchema: z.ZodType<WorkItemFilter> = z.object({
  projectIds: z.array(z.string()).optional(),
  typeIds: z.array(z.string()).optional(),
  columnKeys: z.array(z.string()).optional(),
  priorities: z.array(z.nativeEnum(Priority)).optional(),
  assigneeIds: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  intervalIds: z.array(z.string()).optional(),
  parent: parentSchema,
  startDate: dateRangeSchema,
  dueDate: dateRangeSchema,
  createdAt: dateRangeSchema,
  updatedAt: dateRangeSchema,
  text: z.string().optional(),
  customFields: z.array(customFieldFilterSchema).optional(),
});

const sortSchema = z
  .object({
    field: z.enum(SORT_FIELDS as readonly [WorkItemSortField, ...WorkItemSortField[]]),
    direction: z.enum(["asc", "desc"]).default("desc"),
  })
  .optional();

/** Full query schema for the POST body: filter + sort + pagination. */
export const workItemQuerySchema = z.object({
  filter: workItemFilterSchema.default({}),
  sort: sortSchema,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type WorkItemQueryInput = z.infer<typeof workItemQuerySchema>;

export interface ParsedQuery {
  filter: WorkItemFilter;
  sort: WorkItemSort | undefined;
  page: number;
  pageSize: number;
}

/** Read a repeated/CSV multi-value param: `?k=a&k=b` or `?k=a,b`. */
function multi(params: URLSearchParams, key: string): string[] | undefined {
  const all = params.getAll(key);
  if (all.length === 0) return undefined;
  const values = all.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

const CUSTOM_FIELD_KINDS = new Set<CustomFieldFilterKind>([
  "SELECT",
  "MULTI_SELECT",
  "CHECKBOX",
  "TEXT",
]);

/**
 * Parse repeated `cf` params into custom-field constraints. Each value is
 * `key~kind~value` (tilde-delimited — custom-field keys are [a-z0-9_], so a
 * tilde never collides). A CHECKBOX value of "true"/"false" is coerced to a
 * boolean; everything else stays a string. Malformed entries are dropped.
 */
function parseCustomFieldParams(params: URLSearchParams): CustomFieldFilter[] {
  const out: CustomFieldFilter[] = [];
  for (const raw of params.getAll("cf")) {
    const idx1 = raw.indexOf("~");
    const idx2 = raw.indexOf("~", idx1 + 1);
    if (idx1 < 1 || idx2 < 0) continue;
    const key = raw.slice(0, idx1).trim();
    const kindRaw = raw.slice(idx1 + 1, idx2).trim().toUpperCase();
    const valueRaw = raw.slice(idx2 + 1);
    if (!key || !CUSTOM_FIELD_KINDS.has(kindRaw as CustomFieldFilterKind)) continue;
    const kind = kindRaw as CustomFieldFilterKind;
    const value =
      kind === "CHECKBOX" ? valueRaw.toLowerCase() === "true" : valueRaw;
    if (kind !== "CHECKBOX" && value === "") continue;
    out.push({ key, kind, value });
  }
  return out;
}

/**
 * Parse URL search params into a validated query. Multi-selects accept either
 * repeated keys (`project=a&project=b`) or a CSV (`project=a,b`). Clamps
 * pageSize and ignores unknown values (zod drops anything malformed at the
 * schema layer downstream).
 */
export function parseSearchParams(params: URLSearchParams): ParsedQuery {
  const priorityRaw = multi(params, "priority") ?? [];
  const priorities = priorityRaw.filter(
    (p): p is Priority => (Object.values(Priority) as string[]).includes(p),
  );

  const parentMode = params.get("parent");
  let parent: WorkItemFilter["parent"];
  if (parentMode === "has_parent" || parentMode === "no_parent") {
    parent = { mode: parentMode };
  } else {
    const parentIds = multi(params, "parentId");
    if (parentIds) parent = { mode: "is", parentIds };
  }

  // `?archived=only|all`, defaulting to active. `?includeArchived=1` shipped
  // first and meant "all", so it stays an alias rather than a break — but only
  // the exact string "1", so a stray `includeArchived=false` cannot read as
  // truthy and quietly un-hide everything.
  const archivedParam = params.get("archived");
  const archived: WorkItemFilter["archived"] =
    archivedParam === "only" || archivedParam === "all"
      ? archivedParam
      : params.get("includeArchived") === "1"
        ? "all"
        : "active";

  const startFrom = params.get("startFrom") ?? undefined;
  const startTo = params.get("startTo") ?? undefined;
  const dueFrom = params.get("dueFrom") ?? undefined;
  const dueTo = params.get("dueTo") ?? undefined;
  const createdFrom = params.get("createdFrom") ?? undefined;
  const createdTo = params.get("createdTo") ?? undefined;
  const updatedFrom = params.get("updatedFrom") ?? undefined;
  const updatedTo = params.get("updatedTo") ?? undefined;

  const customFields = parseCustomFieldParams(params);

  const filter: WorkItemFilter = {
    archived,
    projectIds: multi(params, "project"),
    typeIds: multi(params, "type"),
    columnKeys: multi(params, "status"),
    priorities: priorities.length > 0 ? priorities : undefined,
    assigneeIds: multi(params, "assignee"),
    labels: multi(params, "label"),
    intervalIds: multi(params, "interval"),
    parent,
    startDate: startFrom || startTo ? { from: startFrom, to: startTo } : undefined,
    dueDate: dueFrom || dueTo ? { from: dueFrom, to: dueTo } : undefined,
    createdAt: createdFrom || createdTo ? { from: createdFrom, to: createdTo } : undefined,
    updatedAt: updatedFrom || updatedTo ? { from: updatedFrom, to: updatedTo } : undefined,
    text: params.get("text")?.trim() || undefined,
    customFields: customFields.length > 0 ? customFields : undefined,
  };

  const sortField = params.get("sortField");
  const sort: WorkItemSort | undefined =
    sortField && (SORT_FIELDS as readonly string[]).includes(sortField)
      ? {
          field: sortField as WorkItemSortField,
          direction: params.get("sortDir") === "asc" ? "asc" : "desc",
        }
      : undefined;

  const page = clampInt(params.get("page"), 1, 1, Number.MAX_SAFE_INTEGER);
  const pageSize = clampInt(params.get("pageSize"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);

  return { filter, sort, page, pageSize };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Every query parameter the work-item search surface understands.
 *
 * WHY THIS EXISTS. An unrecognised parameter used to be silently dropped, so
 * `?search=`, `?q=`, `?limit=`, `?offset=` and `?cursor=` all returned an
 * unfiltered first page instead of an error. A filter that silently does not
 * filter is worse than one that fails: it returns plausible WRONG answers. A
 * caller paging with `?offset=` re-read page 1 sixteen times and concluded the
 * ticket it wanted did not exist — the API answered truthfully and uselessly
 * that there were 25 items, every time.
 *
 * KEEP THIS IN SYNC. Adding a parameter to the parser without adding it here
 * turns that new filter into a 400 — the failure runs the other way, which is
 * why `parse.params.test.ts` reads this file and asserts every parameter the
 * parser actually reads appears in this set. The list cannot drift silently.
 */
export const KNOWN_QUERY_PARAMS: ReadonlySet<string> = new Set([
  // multi-value filters
  "project", "type", "status", "assignee", "label", "interval", "priority",
  // custom fields, repeated
  "cf",
  // hierarchy + archive state
  "parent", "parentId", "archived", "includeArchived",
  // date ranges
  "startFrom", "startTo", "dueFrom", "dueTo",
  "createdFrom", "createdTo", "updatedFrom", "updatedTo",
  // free text, sort, paging
  "text", "sortField", "sortDir", "page", "pageSize",
]);

/**
 * Parameters a caller supplied that nothing will read.
 *
 * `extra` is for parameters a ROUTE handles itself rather than through
 * `parseSearchParams` — `watchedByMe` on the search route is the only one
 * today. Passing it there keeps the check honest at the route that owns it,
 * instead of widening the shared set for every caller.
 */
export function unknownQueryParams(
  params: URLSearchParams,
  extra: readonly string[] = [],
): string[] {
  const allowed = new Set([...KNOWN_QUERY_PARAMS, ...extra]);
  // De-duplicated: `?project=a&project=b` would otherwise report twice.
  return [...new Set([...params.keys()])].filter((k) => !allowed.has(k));
}
