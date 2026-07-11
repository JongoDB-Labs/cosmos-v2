/**
 * The common **Cosmos item schema** — one consistent, flat structure that every
 * kind of project item (issue, OKR objective, milestone, sprint) is projected
 * onto for export.
 *
 * Why a shared schema: each source model is shaped differently (a WorkItem has a
 * ticket key + story points, an Objective has progress %, a Cycle has start/end
 * dates and no updatedAt). Rather than a bespoke CSV per type, we normalise them
 * all to a `CosmosItem` with a fixed, ordered column set. Every column is present
 * for every row; a field a given kind doesn't carry is simply blank (Priority is
 * blank for a sprint, Progress is blank for an issue, and so on) — exactly the way
 * a unified register is expected to read. The `Kind` column discriminates rows so
 * a single CSV can hold all four types at once.
 *
 * This module is PURE (no Prisma, no I/O) so the mapping is unit-testable in
 * isolation — the route layer resolves the cross-references (project/owner names,
 * parent keys) and hands plain objects to these mappers.
 */
import { toCSV } from "./csv";

export type CosmosItemKind = "issue" | "objective" | "milestone" | "sprint";

/** Human-facing label for the `Kind` column. */
export const COSMOS_KIND_LABELS: Record<CosmosItemKind, string> = {
  issue: "Issue",
  objective: "Objective",
  milestone: "Milestone",
  sprint: "Sprint",
};

/**
 * The unified row. Optional-by-type fields use `""`/`null`/`[]` when a kind has
 * no value for them so the CSV cell is simply empty — the schema itself is the
 * same across every kind.
 */
export interface CosmosItem {
  kind: CosmosItemKind;
  /** Stable internal id (UUID) — unique across every row regardless of kind. */
  id: string;
  /** Human key where the kind has one (issue ticket key); blank otherwise. */
  key: string;
  title: string;
  /** Sub-type label: work-item type name / "Objective" / "Milestone" / cycle kind. */
  type: string;
  /** Status/lane text (issue column key, or the kind's status enum). */
  status: string;
  /** Issue priority; blank for the other kinds. */
  priority: string;
  /** 0–100 completion where the kind tracks it (objectives); null otherwise. */
  progress: number | null;
  /** Assignee/owner display name; blank where unassigned or not applicable. */
  owner: string;
  /** Project name the item belongs to. */
  project: string;
  /** Parent reference (issue parent key / objective parent title / PI name). */
  parent: string;
  /** Free-text body: objective/milestone description, or a sprint's goal. */
  description: string;
  /** Issue story points; null otherwise. */
  storyPoints: number | null;
  /** Issue tags/labels; empty for the other kinds. */
  tags: string[];
  /** yyyy-mm-dd (issue start, sprint start) or null. */
  startDate: string | null;
  /** yyyy-mm-dd target/end (issue due, objective target, milestone due, sprint end) or null. */
  dueDate: string | null;
  /** yyyy-mm-dd completion (issue/milestone) or null. */
  completedAt: string | null;
  /** yyyy-mm-dd created or null. */
  createdAt: string | null;
  /** yyyy-mm-dd last updated (blank for sprints — Cycle has no updatedAt). */
  updatedAt: string | null;
}

type Dateish = Date | string | null | undefined;

/** Normalise a Date / ISO string to a `yyyy-mm-dd` day, or null when absent. */
export function toDay(value: Dateish): string | null {
  if (!value) return null;
  const iso = value instanceof Date ? value.toISOString() : String(value);
  return iso.slice(0, 10);
}

const CYCLE_KIND_LABELS: Record<string, string> = {
  SPRINT: "Sprint",
  PHASE: "Phase",
  MODULE: "Module",
  RUN: "Run",
  EVENT_DAY: "Event Day",
  RELEASE: "Release",
  ITERATION: "Iteration",
  PROGRAM_INCREMENT: "Program Increment",
};

/** Friendly label for a raw `CycleKind` enum value (falls back to the raw value). */
export function cycleKindLabel(kind: string): string {
  return CYCLE_KIND_LABELS[kind] ?? kind;
}

/**
 * The ordered CSV column set. `header` is the column name; `value` extracts the
 * cell from a `CosmosItem`. This single list is the source of truth for both the
 * column order and the empty-set header row — so the CSV shape can never drift
 * between the two.
 */
export const COSMOS_CSV_COLUMNS: {
  header: string;
  value: (item: CosmosItem) => string | number;
}[] = [
  { header: "Kind", value: (i) => COSMOS_KIND_LABELS[i.kind] },
  { header: "ID", value: (i) => i.id },
  { header: "Key", value: (i) => i.key },
  { header: "Title", value: (i) => i.title },
  { header: "Type", value: (i) => i.type },
  { header: "Status", value: (i) => i.status },
  { header: "Priority", value: (i) => i.priority },
  { header: "Progress", value: (i) => i.progress ?? "" },
  { header: "Owner", value: (i) => i.owner },
  { header: "Project", value: (i) => i.project },
  { header: "Parent", value: (i) => i.parent },
  { header: "Description", value: (i) => i.description },
  { header: "Story Points", value: (i) => i.storyPoints ?? "" },
  { header: "Tags", value: (i) => i.tags.join("; ") },
  { header: "Start Date", value: (i) => i.startDate ?? "" },
  { header: "Due Date", value: (i) => i.dueDate ?? "" },
  { header: "Completed", value: (i) => i.completedAt ?? "" },
  { header: "Created", value: (i) => i.createdAt ?? "" },
  { header: "Updated", value: (i) => i.updatedAt ?? "" },
];

/** The header row (column names in schema order). */
export const COSMOS_CSV_HEADERS: string[] = COSMOS_CSV_COLUMNS.map((c) => c.header);

/** Project one `CosmosItem` onto the ordered `{ header: cell }` row `toCSV` consumes. */
export function cosmosItemToRow(item: CosmosItem): Record<string, string | number> {
  const row: Record<string, string | number> = {};
  for (const col of COSMOS_CSV_COLUMNS) row[col.header] = col.value(item);
  return row;
}

/**
 * Serialise items to a well-formed CSV using the common schema.
 *
 * An empty list still yields a valid header-only file (never an empty body), and
 * the whole list is written with no cap so large exports are never truncated.
 */
export function serializeCosmosCsv(items: CosmosItem[]): string {
  if (items.length === 0) return COSMOS_CSV_HEADERS.join(",");
  return toCSV(items.map(cosmosItemToRow));
}

// ── Per-kind mappers ─────────────────────────────────────────────────────────
// Each takes the resolved (name-flattened) input for one source model and returns
// a CosmosItem. The route layer does the DB joins; these stay pure.

export interface IssueExportInput {
  id: string;
  ticketKey: string;
  title: string;
  typeName: string;
  columnKey: string;
  priority: string;
  assigneeName?: string | null;
  projectName: string;
  parentKey?: string | null;
  description?: string | null;
  storyPoints?: number | null;
  tags?: string[];
  startDate?: Dateish;
  dueDate?: Dateish;
  completedAt?: Dateish;
  createdAt?: Dateish;
  updatedAt?: Dateish;
}

export function issueToCosmosItem(x: IssueExportInput): CosmosItem {
  return {
    kind: "issue",
    id: x.id,
    key: x.ticketKey,
    title: x.title,
    type: x.typeName,
    status: x.columnKey,
    priority: x.priority,
    progress: null,
    owner: x.assigneeName ?? "",
    project: x.projectName,
    parent: x.parentKey ?? "",
    description: x.description ?? "",
    storyPoints: x.storyPoints ?? null,
    tags: x.tags ?? [],
    startDate: toDay(x.startDate),
    dueDate: toDay(x.dueDate),
    completedAt: toDay(x.completedAt),
    createdAt: toDay(x.createdAt),
    updatedAt: toDay(x.updatedAt),
  };
}

export interface ObjectiveExportInput {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  progress?: number | null;
  ownerName?: string | null;
  projectName: string;
  parentTitle?: string | null;
  targetDate?: Dateish;
  createdAt?: Dateish;
  updatedAt?: Dateish;
}

export function objectiveToCosmosItem(x: ObjectiveExportInput): CosmosItem {
  return {
    kind: "objective",
    id: x.id,
    key: "",
    title: x.title,
    type: "Objective",
    status: x.status,
    priority: "",
    progress: x.progress ?? null,
    owner: x.ownerName ?? "",
    project: x.projectName,
    parent: x.parentTitle ?? "",
    description: x.description ?? "",
    storyPoints: null,
    tags: [],
    startDate: null,
    dueDate: toDay(x.targetDate),
    completedAt: null,
    createdAt: toDay(x.createdAt),
    updatedAt: toDay(x.updatedAt),
  };
}

export interface MilestoneExportInput {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  ownerName?: string | null;
  projectName: string;
  dueDate?: Dateish;
  completedAt?: Dateish;
  createdAt?: Dateish;
  updatedAt?: Dateish;
}

export function milestoneToCosmosItem(x: MilestoneExportInput): CosmosItem {
  return {
    kind: "milestone",
    id: x.id,
    key: "",
    title: x.title,
    type: "Milestone",
    status: x.status,
    priority: "",
    progress: null,
    owner: x.ownerName ?? "",
    project: x.projectName,
    parent: "",
    description: x.description ?? "",
    storyPoints: null,
    tags: [],
    startDate: null,
    dueDate: toDay(x.dueDate),
    completedAt: toDay(x.completedAt),
    createdAt: toDay(x.createdAt),
    updatedAt: toDay(x.updatedAt),
  };
}

export interface SprintExportInput {
  id: string;
  name: string;
  cycleKind: string;
  status: string;
  goal?: string | null;
  projectName: string;
  parentName?: string | null;
  startDate?: Dateish;
  endDate?: Dateish;
  createdAt?: Dateish;
}

export function sprintToCosmosItem(x: SprintExportInput): CosmosItem {
  return {
    kind: "sprint",
    id: x.id,
    key: "",
    title: x.name,
    type: cycleKindLabel(x.cycleKind),
    status: x.status,
    priority: "",
    progress: null,
    owner: "",
    project: x.projectName,
    parent: x.parentName ?? "",
    description: x.goal ?? "",
    storyPoints: null,
    tags: [],
    startDate: toDay(x.startDate),
    dueDate: toDay(x.endDate),
    completedAt: null,
    createdAt: toDay(x.createdAt),
    updatedAt: null,
  };
}
