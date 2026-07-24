/**
 * JQL-lite cross-project work-item query — the TYPED FILTER MODEL.
 *
 * This is the foundation for an org-wide Issues view and, eventually, "save a
 * search as a board". The model is intentionally serialisable (plain JSON) so a
 * filter can round-trip through a URL, a saved view, or a board's `config`.
 *
 * Semantics (mirrors JQL's mental model):
 *   - AND across distinct fields (project AND type AND status …).
 *   - OR within a single multi-select field (project in [A, B] → A OR B).
 *   - A multi-select with one value behaves like equality.
 *   - An omitted / empty field is INERT (does not constrain).
 *
 * The where-builder (`build-where.ts`) is PURE — it never touches the DB. RBAC
 * scoping (which projects the actor may see) is resolved separately in
 * `scope.ts` and folded in as an `allowedProjectIds` constraint, so the
 * builder can stay synchronous + exhaustively unit-tested.
 */
import { Priority } from "@prisma/client";

/** A boolean-ish parent constraint plus an optional specific-parent filter. */
export type ParentFilter =
  | { mode: "any" } // no constraint
  | { mode: "has_parent" } // parentId IS NOT NULL (sub-items only)
  | { mode: "no_parent" } // parentId IS NULL (top-level only)
  | { mode: "is"; parentIds: string[] }; // parentId IN [...]

/** An inclusive date-range bound. Either edge may be omitted (open-ended). */
export interface DateRange {
  /** ISO-8601 date/datetime string, inclusive lower bound. */
  from?: string;
  /** ISO-8601 date/datetime string, inclusive upper bound. */
  to?: string;
}

/**
 * The full filter model. Every field is optional; an absent/empty field is
 * inert. Multi-value array fields are OR-within, AND-across.
 */
export interface WorkItemFilter {
  /** WorkItem.id values — direct id lookup (still intersected with RBAC project
   *  scope). Used to open a single item by id (e.g. a mention deep-link). */
  ids?: string[];
  /** Project.id values — OR within, scoped to allowed projects by the builder. */
  projectIds?: string[];
  /** WorkItemType.id values. */
  typeIds?: string[];
  /** Board column keys (the work item's status lane), e.g. "in-progress". */
  columnKeys?: string[];
  /** Priority enum values. */
  priorities?: Priority[];
  /**
   * Assignee User.id values. The sentinel "unassigned" matches items with a
   * NULL assignee, and can be mixed with real ids (e.g. "me OR unassigned").
   */
  assigneeIds?: string[];
  /** Tag/label values — HAS-ANY semantics (item.tags overlaps the set). */
  labels?: string[];
  /** Interval/sprint Interval.id values. The sentinel "none" matches NULL intervalId. */
  intervalIds?: string[];
  /** Parent (hierarchy) constraint. */
  parent?: ParentFilter;
  /** Inclusive range over WorkItem.startDate. */
  startDate?: DateRange;
  /** Inclusive range over WorkItem.dueDate. */
  dueDate?: DateRange;
  /** Inclusive range over WorkItem.createdAt (when the item was created). */
  createdAt?: DateRange;
  /** Inclusive range over WorkItem.updatedAt (last modified). */
  updatedAt?: DateRange;
  /** Free-text — case-insensitive contains over title OR description. */
  text?: string;
  /**
   * Per-custom-field equality constraints over the WorkItem.customFields JSON.
   * AND-across (every entry must match). Scoped to the filterable field kinds:
   *   - SELECT / TEXT / CHECKBOX → exact match on the value at `key`.
   *   - MULTI_SELECT → the stored array at `key` contains `value`.
   * Other kinds (NUMBER ranges, DATE, URL, EMAIL, USER) are intentionally not
   * filterable here yet.
   */
  customFields?: CustomFieldFilter[];
  /** When set, restrict to items this User.id watches (FR 8702c9b8). The route
   *  resolves `?watchedByMe=1` to the caller's id so build-where stays pure. */
  watchedByUserId?: string;
}

/** The custom-field kinds we support filtering on. */
export type CustomFieldFilterKind = "SELECT" | "MULTI_SELECT" | "CHECKBOX" | "TEXT";

/** A single custom-field equality constraint (keyed by CustomField.key). */
export interface CustomFieldFilter {
  /** The CustomField.key the value lives under in WorkItem.customFields. */
  key: string;
  /** How to interpret `value` against the JSON at `key`. */
  kind: CustomFieldFilterKind;
  /** Match value — a string for SELECT/MULTI_SELECT/TEXT, boolean for CHECKBOX. */
  value: string | boolean;
}

/** Matches a NULL assignee when present in `assigneeIds`. */
export const UNASSIGNED = "unassigned" as const;
/** Matches a NULL interval when present in `intervalIds`. */
export const NO_INTERVAL = "none" as const;

/** Sort fields the list view + API expose (whitelist — anything else falls
 *  back to a stable default in the builder). */
export type WorkItemSortField =
  | "createdAt"
  | "updatedAt"
  | "priority"
  | "dueDate"
  | "startDate"
  | "ticketNumber";

export interface WorkItemSort {
  field: WorkItemSortField;
  direction: "asc" | "desc";
}

export const SORT_FIELDS: readonly WorkItemSortField[] = [
  "createdAt",
  "updatedAt",
  "priority",
  "dueDate",
  "startDate",
  "ticketNumber",
] as const;

/** Hard cap on page size — protects the DB from an unbounded scan. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;
