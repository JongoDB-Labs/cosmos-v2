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

/** zod schema for the filter object (shared by GET-normalised + POST bodies). */
export const workItemFilterSchema: z.ZodType<WorkItemFilter> = z.object({
  projectIds: z.array(z.string()).optional(),
  typeIds: z.array(z.string()).optional(),
  columnKeys: z.array(z.string()).optional(),
  priorities: z.array(z.nativeEnum(Priority)).optional(),
  assigneeIds: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  cycleIds: z.array(z.string()).optional(),
  parent: parentSchema,
  startDate: dateRangeSchema,
  dueDate: dateRangeSchema,
  text: z.string().optional(),
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

  const startFrom = params.get("startFrom") ?? undefined;
  const startTo = params.get("startTo") ?? undefined;
  const dueFrom = params.get("dueFrom") ?? undefined;
  const dueTo = params.get("dueTo") ?? undefined;

  const filter: WorkItemFilter = {
    projectIds: multi(params, "project"),
    typeIds: multi(params, "type"),
    columnKeys: multi(params, "status"),
    priorities: priorities.length > 0 ? priorities : undefined,
    assigneeIds: multi(params, "assignee"),
    labels: multi(params, "label"),
    cycleIds: multi(params, "cycle"),
    parent,
    startDate: startFrom || startTo ? { from: startFrom, to: startTo } : undefined,
    dueDate: dueFrom || dueTo ? { from: dueFrom, to: dueTo } : undefined,
    text: params.get("text")?.trim() || undefined,
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
