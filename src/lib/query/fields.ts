/**
 * The CQL field registry: the closed set of system fields a query may name.
 *
 * One table, read by the parser (names and aliases), the typechecker (which
 * operators and values a field accepts), the compiler, the editor's completion
 * and the dashboards' group-by. Four separate field lists (BoardFilters,
 * WorkItemFilter, SORT_FIELDS, the facets route) drifting apart is the problem
 * this replaces.
 *
 * Pure and client-safe. How a field COMPILES lives in compile.ts (server-side
 * Prisma), keyed by the same ids, and a test asserts every id here is handled
 * there.
 */
import type { RefEntity } from "./ast";

export const SYSTEM_FIELD_IDS = [
  "project",
  "key",
  "type",
  "status",
  "statusCategory",
  "priority",
  "assignee",
  "primaryAssignee",
  "reporter",
  "watcher",
  "label",
  "sprint",
  "intervalKind",
  "pi",
  "team",
  "parent",
  "ancestor",
  "hasChildren",
  "milestone",
  "blocked",
  "linkedTo",
  "points",
  "originalEstimate",
  "remainingEstimate",
  "timeSpent",
  "created",
  "updated",
  "due",
  "start",
  "actualStart",
  "completed",
  "statusChanged",
  "archived",
  "archivedAt",
  "workCategory",
  "cancelReason",
  "resolution",
  "highlight",
  "summary",
  "description",
  "comment",
  "text",
  "hasAttachments",
  "externalKey",
  "externalSource",
  "externalId",
  "sourceStatus",
  "cancelNote",
  "mergedInto",
  "rank",
] as const;
export type SystemFieldId = (typeof SYSTEM_FIELD_IDS)[number];

/**
 * What kind of value a field holds. Drives which operators are legal and how a
 * literal is read (a bare `3d` is a date offset on `due` but a duration on
 * `timeSpent`).
 */
export type ValueKind =
  | { kind: "ref"; entity: RefEntity; multi?: boolean }
  | { kind: "enum"; values: readonly string[]; ordered?: boolean }
  | { kind: "bool" }
  | { kind: "number" }
  | { kind: "duration" }
  | { kind: "date" }
  | { kind: "datetime" }
  | { kind: "text" }
  | { kind: "string" };

/** Operator families a field may accept. */
export type OpFamily =
  | "eq" // = !=
  | "in" // IN, NOT IN
  | "inAll" // IN ALL (multi-valued)
  | "order" // < <= > >=
  | "empty" // IS [NOT] EMPTY
  | "text" // ~ !~
  | "history"; // WAS, CHANGED

export interface FieldDef {
  id: SystemFieldId;
  label: string;
  aliases: readonly string[];
  value: ValueKind;
  ops: readonly OpFamily[];
  /** Sortable in ORDER BY with a plain Prisma orderBy. */
  sortable?: boolean;
  /** Usable as a dashboard / aggregate dimension. */
  groupable?: boolean;
  /** Not queryable yet: compiled by a later phase. The typechecker says so. */
  pending?: string;
  description: string;
}

export const PRIORITY_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const STATUS_CATEGORIES = ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"] as const;
export const WORK_CATEGORIES = ["BUSINESS", "ENABLER"] as const;
export const CANCEL_REASONS = ["OBE", "OTHER", "MERGED"] as const;
export const INTERVAL_KINDS = [
  "SPRINT",
  "PHASE",
  "MODULE",
  "RUN",
  "EVENT_DAY",
  "RELEASE",
  "ITERATION",
  "PROGRAM_INCREMENT",
] as const;
export const HIGHLIGHTS = ["GREEN", "AMBER", "RED", "BLUE", "PURPLE", "GREY"] as const;
export const LINK_TYPES = [
  "BLOCKS",
  "BLOCKED_BY",
  "RELATES",
  "DUPLICATES",
  "PREDECESSOR",
  "SUCCESSOR",
  "CLONES",
] as const;

const DATE_OPS: readonly OpFamily[] = ["eq", "order", "empty"];

export const FIELDS: readonly FieldDef[] = [
  { id: "project", label: "Project", aliases: [], value: { kind: "ref", entity: "project" }, ops: ["eq", "in"], sortable: true, groupable: true, description: "Project key, name or id." },
  { id: "key", label: "Key", aliases: ["issuekey", "id", "ticket"], value: { kind: "ref", entity: "item" }, ops: ["eq", "in", "order"], sortable: true, description: "Ticket key such as ACME-12. `key > ACME-100` compares within the project." },
  { id: "type", label: "Type", aliases: ["issuetype", "workitemtype"], value: { kind: "ref", entity: "type" }, ops: ["eq", "in", "history"], sortable: true, groupable: true, description: "Work item type key or name." },
  { id: "status", label: "Status", aliases: ["column"], value: { kind: "ref", entity: "status" }, ops: ["eq", "in", "history"], sortable: true, groupable: true, description: "Board column name or key." },
  { id: "statusCategory", label: "Status category", aliases: ["category"], value: { kind: "enum", values: STATUS_CATEGORIES }, ops: ["eq", "in"], groupable: true, description: "TODO, IN_PROGRESS, DONE or CANCELLED. DONE also matches anything with a completion date." },
  { id: "priority", label: "Priority", aliases: [], value: { kind: "enum", values: PRIORITY_ORDER, ordered: true }, ops: ["eq", "in", "order", "history"], sortable: true, groupable: true, description: "LOW < MEDIUM < HIGH < CRITICAL." },
  { id: "assignee", label: "Assignee", aliases: ["assignees"], value: { kind: "ref", entity: "user" }, ops: ["eq", "in", "empty", "history"], sortable: true, groupable: true, description: "Matches the primary assignee or any co-assignee. `me` is you." },
  { id: "primaryAssignee", label: "Primary assignee", aliases: [], value: { kind: "ref", entity: "user" }, ops: ["eq", "in", "empty"], groupable: true, description: "Only the primary assignee, ignoring co-assignees." },
  { id: "reporter", label: "Reporter", aliases: ["creator", "createdby"], value: { kind: "ref", entity: "user" }, ops: ["eq", "in"], groupable: true, description: "Who created the item." },
  { id: "watcher", label: "Watcher", aliases: ["watchers"], value: { kind: "ref", entity: "user" }, ops: ["eq", "in", "empty"], description: "Someone watching the item." },
  { id: "label", label: "Label", aliases: ["labels", "tag", "tags"], value: { kind: "ref", entity: "label", multi: true }, ops: ["eq", "in", "inAll", "empty"], groupable: true, description: "`label = x` means it has x; `labels IN ALL (a, b)` needs both." },
  { id: "sprint", label: "Sprint", aliases: ["interval", "iteration"], value: { kind: "ref", entity: "interval" }, ops: ["eq", "in", "empty", "history"], groupable: true, description: "Sprint (interval) name or id; try openSprints()." },
  { id: "intervalKind", label: "Interval kind", aliases: [], value: { kind: "enum", values: INTERVAL_KINDS }, ops: ["eq", "in"], description: "The kind of interval the item is planned into." },
  { id: "pi", label: "Program increment", aliases: ["programincrement"], value: { kind: "ref", entity: "interval" }, ops: ["eq", "in"], description: "Items in the PI or in any sprint inside it." },
  { id: "team", label: "Team", aliases: [], value: { kind: "ref", entity: "team" }, ops: ["eq", "in", "empty", "history"], groupable: true, description: "The team the item belongs to. Use `assignee IN membersOf(\"Team\")` for its members' work." },
  { id: "parent", label: "Parent", aliases: [], value: { kind: "ref", entity: "item" }, ops: ["eq", "in", "empty"], description: "The parent item's key." },
  { id: "ancestor", label: "Ancestor", aliases: [], value: { kind: "ref", entity: "item" }, ops: ["eq", "in"], description: "Any item above this one, at any depth: `ancestor = ACME-1` is everything under ACME-1." },
  // The other half of `parent IS EMPTY`: that asks for a root, this asks whether
  // anything hangs underneath. `parent` / `ancestor` / `childrenOf()` all need a
  // NAMED parent, so "which of these are still leaves" had no spelling.
  { id: "hasChildren", label: "Has sub-items", aliases: ["children", "subitems"], value: { kind: "bool" }, ops: ["eq"], description: "`hasChildren = true` when the item has at least one sub-item; `= false` is a leaf. An archived sub-item doesn't count." },
  { id: "milestone", label: "Milestone", aliases: ["milestones"], value: { kind: "ref", entity: "milestone" }, ops: ["eq", "in", "empty"], description: "A milestone the item is linked to." },
  { id: "blocked", label: "Blocked", aliases: [], value: { kind: "bool" }, ops: ["eq"], description: "`blocked = true` when another item blocks it." },
  { id: "linkedTo", label: "Linked to", aliases: ["linked"], value: { kind: "ref", entity: "item" }, ops: ["eq", "in"], description: "Linked to the given item, any link type." },
  { id: "points", label: "Story points", aliases: ["storypoints", "estimate"], value: { kind: "number" }, ops: ["eq", "in", "order", "empty"], sortable: true, description: "Story points." },
  { id: "originalEstimate", label: "Original estimate", aliases: [], value: { kind: "duration" }, ops: ["eq", "order", "empty"], sortable: true, description: "Time estimate, e.g. `> 2d` (1d = 8h)." },
  { id: "remainingEstimate", label: "Remaining estimate", aliases: [], value: { kind: "duration" }, ops: ["eq", "order", "empty"], sortable: true, description: "Time remaining, e.g. `< 4h`." },
  { id: "timeSpent", label: "Time spent", aliases: [], value: { kind: "duration" }, ops: ["eq", "order", "empty"], sortable: true, description: "Logged time." },
  { id: "created", label: "Created", aliases: ["createddate", "createdat"], value: { kind: "datetime" }, ops: ["eq", "order"], sortable: true, description: "When the item was created; `created > -7d`." },
  { id: "updated", label: "Updated", aliases: ["updateddate", "updatedat"], value: { kind: "datetime" }, ops: ["eq", "order"], sortable: true, description: "Last change." },
  { id: "due", label: "Due", aliases: ["duedate"], value: { kind: "date" }, ops: [...DATE_OPS, "history"], sortable: true, description: "Due date; `due < now()` is overdue." },
  { id: "start", label: "Start", aliases: ["startdate"], value: { kind: "date" }, ops: [...DATE_OPS, "history"], sortable: true, description: "Planned start." },
  { id: "actualStart", label: "Actual start", aliases: [], value: { kind: "datetime" }, ops: DATE_OPS, sortable: true, description: "When work actually started." },
  { id: "completed", label: "Completed", aliases: ["resolved", "resolutiondate", "completedat"], value: { kind: "datetime" }, ops: [...DATE_OPS, "history"], sortable: true, description: "When it was finished." },
  { id: "statusChanged", label: "In status since", aliases: [], value: { kind: "datetime" }, ops: ["order"], sortable: true, description: "When it entered its current column." },
  { id: "archived", label: "Archived", aliases: [], value: { kind: "bool" }, ops: ["eq"], description: "Archived items are left out unless the query mentions `archived`." },
  { id: "archivedAt", label: "Archived at", aliases: [], value: { kind: "datetime" }, ops: DATE_OPS, sortable: true, description: "When it was archived." },
  { id: "workCategory", label: "Work category", aliases: [], value: { kind: "enum", values: WORK_CATEGORIES }, ops: ["eq", "in"], groupable: true, description: "BUSINESS or ENABLER." },
  { id: "cancelReason", label: "Cancel reason", aliases: [], value: { kind: "enum", values: CANCEL_REASONS }, ops: ["eq", "in", "empty"], description: "OBE, OTHER or MERGED." },
  { id: "resolution", label: "Resolution", aliases: [], value: { kind: "string" }, ops: ["eq", "text", "empty"], description: "Resolution imported from Jira." },
  { id: "highlight", label: "Highlight", aliases: [], value: { kind: "enum", values: HIGHLIGHTS }, ops: ["eq", "in", "empty"], groupable: true, description: "Meeting callout: GREEN on track, AMBER at risk, RED blocked, …" },
  { id: "summary", label: "Summary", aliases: ["title"], value: { kind: "text" }, ops: ["text"], description: "Title contains, case-insensitive; `~ \"log*\"` is a prefix." },
  { id: "description", label: "Description", aliases: [], value: { kind: "text" }, ops: ["text", "empty"], description: "Description contains." },
  { id: "comment", label: "Comment", aliases: ["comments"], value: { kind: "text" }, ops: ["text"], description: "Any comment contains." },
  { id: "text", label: "Text", aliases: [], value: { kind: "text" }, ops: ["text"], description: "Title, description or comments contain." },
  // A bool rather than an `IS EMPTY` over a `documents` ref, deliberately: it
  // needs no new RefEntity and no suggestions endpoint, and nobody filters for
  // "the item carrying THAT file" — they ask whether anything is attached. What
  // counts as attached is per-viewer, which the compiler spells out.
  // No `files` alias on purpose: a system field SHADOWS a custom field of the
  // same name (parser.ts), `files` is a plausible custom-field name, and the
  // word is already searchable through this description.
  { id: "hasAttachments", label: "Has attachments", aliases: ["attachments"], value: { kind: "bool" }, ops: ["eq"], description: "`hasAttachments = true` when a file you can see is attached, e.g. `type = Bug AND attachments = false`. Files restricted to other people don't count." },
  { id: "externalKey", label: "External key", aliases: [], value: { kind: "string" }, ops: ["eq", "text", "empty"], description: "Key from an imported system, e.g. PROJ-123." },
  { id: "externalSource", label: "External source", aliases: [], value: { kind: "string" }, ops: ["eq", "text", "empty"], description: "Imported from, e.g. jira." },
  // FR 5409a485: ticket metadata that existed on the row and could not be
  // queried. `externalKey` was filterable while its sibling `externalId` — the
  // source system's own identifier, which is what an integration actually joins
  // on — was not; `sourceStatus` holds the raw upstream status, which survives
  // import precisely so it can be inspected; and `cancelNote` is the reason
  // text a cancellation carries, unreachable even though `cancelReason` was
  // filterable.
  { id: "externalId", label: "External ID", aliases: [], value: { kind: "string" }, ops: ["eq", "text", "empty"], description: "The source system's own identifier for an imported item (its key is `externalKey`)." },
  { id: "sourceStatus", label: "Source status", aliases: [], value: { kind: "string" }, ops: ["eq", "text", "empty"], description: "The raw status text as the source system had it, kept unmapped on import." },
  { id: "cancelNote", label: "Cancel note", aliases: [], value: { kind: "string" }, ops: ["eq", "text", "empty"], description: "The note recorded when an item was cancelled (its reason is `cancelReason`)." },
  // `cancelReason = MERGED` could say THAT an item was merged and never WHICH
  // item it went into, though the column has existed since COSMOS-207. "Merged
  // into" is the product's own phrase for it — the merge dialog, the toast, the
  // cancel note the merge writes and the feedback board all use it.
  { id: "mergedInto", label: "Merged into", aliases: ["merged", "mergedintoid"], value: { kind: "ref", entity: "item" }, ops: ["eq", "in", "empty"], description: "The item a duplicate was merged into: `mergedInto = ACME-12` is everything folded into ACME-12, and `mergedInto IS EMPTY` leaves merged duplicates out." },
  { id: "rank", label: "Rank", aliases: [], value: { kind: "number" }, ops: [], sortable: true, description: "Board order (ORDER BY only)." },
];

const byId = new Map<SystemFieldId, FieldDef>(FIELDS.map((f) => [f.id, f]));
const byName = new Map<string, FieldDef>();
for (const f of FIELDS) {
  byName.set(f.id.toLowerCase(), f);
  for (const a of f.aliases) byName.set(a.toLowerCase(), f);
}

export function fieldDef(id: SystemFieldId): FieldDef {
  return byId.get(id)!;
}

/** Case-insensitive lookup by id or alias. */
export function lookupField(name: string): FieldDef | undefined {
  return byName.get(name.toLowerCase());
}

/** Every spelling, for "did you mean" suggestions. */
export function allFieldNames(): string[] {
  return [...byName.keys()];
}

/** Fields a history operator (WAS / CHANGED) can query: what Activity records. */
export function isHistoryField(id: SystemFieldId): boolean {
  return fieldDef(id).ops.includes("history");
}

/**
 * JQL fields with no Cosmos equivalent, and what to use instead. A Jira query
 * pasted in gets a pointed message instead of "unknown field".
 */
export const JQL_UNMAPPED: Readonly<Record<string, string>> = {
  fixversion: "Cosmos has no fix versions. Try `sprint` or `milestone`.",
  affectedversion: "Cosmos has no versions. Try `label`.",
  component: "Cosmos has no components. Try `label` or `team`.",
  components: "Cosmos has no components. Try `label` or `team`.",
  epic: "Use `parent = KEY` or `ancestor = KEY`.",
  "epic link": "Use `parent = KEY` or `ancestor = KEY`.",
  environment: "Cosmos has no environment field. Try a custom field.",
};
