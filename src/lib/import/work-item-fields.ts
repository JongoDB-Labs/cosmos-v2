/**
 * Shared contract for the work-item importer (client wizard + server engine).
 * Client-safe: NO server-only imports here.
 *
 * The importer maps arbitrary source columns (Jira/Linear/CSV exports) onto the
 * WorkItem model. The schema already carries Jira-shaped provenance columns
 * (externalSource/externalId/externalKey/sourceStatus/resolution/sourceRecord +
 * time tracking in seconds), so a mapped import is lossless and re-runnable.
 */

/** A target field a source column can map to. */
export type TargetFieldId =
  | "title"
  | "description"
  | "type" // → WorkItemType (value-mapped)
  | "status" // → board columnKey (value-mapped)
  | "priority" // → Priority enum (value-mapped)
  | "assignee" // → org member (value-mapped, by email/name)
  | "assignees" // → full assignee set — emails/names split on , or ; (server-resolved)
  | "interval" // → project interval/sprint, matched by name or number (server-resolved)
  | "tags" // split on , or ;
  | "storyPoints"
  | "dueDate"
  | "startDate"
  | "completedAt"
  | "externalKey" // source key e.g. PROJ-123 (also the parent-link key)
  | "externalId" // source id — idempotency key
  | "parentKey" // parent's source key → linked in pass 2
  | "originalEstimate" // Jira duration or seconds → seconds
  | "remainingEstimate"
  | "timeSpent"
  | "resolution"
  | "custom"; // dumped into customFields[sourceHeader]

/** Sentinel mapping value meaning "don't import this column". */
export const IGNORE = "__ignore__";

export interface TargetField {
  id: TargetFieldId;
  label: string;
}

export const TARGET_FIELDS: TargetField[] = [
  { id: "title", label: "Summary / Title" },
  { id: "description", label: "Description" },
  { id: "type", label: "Issue Type" },
  { id: "status", label: "Status" },
  { id: "priority", label: "Priority" },
  { id: "assignee", label: "Assignee" },
  { id: "assignees", label: "Assignees (multiple)" },
  { id: "interval", label: "Sprint / Interval" },
  { id: "tags", label: "Labels / Tags" },
  { id: "storyPoints", label: "Story Points" },
  { id: "dueDate", label: "Due Date" },
  { id: "startDate", label: "Start Date" },
  { id: "completedAt", label: "Completed / Resolved Date" },
  { id: "externalKey", label: "Issue Key" },
  { id: "externalId", label: "Issue ID" },
  { id: "parentKey", label: "Parent Link" },
  { id: "originalEstimate", label: "Original Estimate" },
  { id: "remainingEstimate", label: "Remaining Estimate" },
  { id: "timeSpent", label: "Time Spent" },
  { id: "resolution", label: "Resolution" },
  { id: "custom", label: "Custom field (keep)" },
];

/** Header synonyms → target, for auto-guessing the mapping on upload. */
const HEADER_SYNONYMS: Record<string, TargetFieldId> = {
  summary: "title",
  title: "title",
  name: "title",
  description: "description",
  desc: "description",
  body: "description",
  "issue type": "type",
  issuetype: "type",
  type: "type",
  status: "status",
  state: "status",
  "workflow status": "status",
  priority: "priority",
  assignee: "assignee",
  "assigned to": "assignee",
  owner: "assignee",
  assignees: "assignees",
  sprint: "interval",
  "sprint name": "interval",
  interval: "interval",
  "interval name": "interval",
  iteration: "interval",
  "iteration path": "interval",
  resolved: "completedAt",
  "resolved date": "completedAt",
  "done date": "completedAt",
  completed: "completedAt",
  "completed date": "completedAt",
  labels: "tags",
  label: "tags",
  tags: "tags",
  tag: "tags",
  components: "tags",
  "story points": "storyPoints",
  "story point estimate": "storyPoints",
  points: "storyPoints",
  sp: "storyPoints",
  "due date": "dueDate",
  due: "dueDate",
  duedate: "dueDate",
  "start date": "startDate",
  startdate: "startDate",
  "issue key": "externalKey",
  key: "externalKey",
  "issue id": "externalId",
  id: "externalId",
  "parent": "parentKey",
  "parent key": "parentKey",
  "parent id": "parentKey",
  "epic link": "parentKey",
  "original estimate": "originalEstimate",
  "σ original estimate": "originalEstimate",
  "remaining estimate": "remainingEstimate",
  "σ remaining estimate": "remainingEstimate",
  "time spent": "timeSpent",
  "σ time spent": "timeSpent",
  "log work": "timeSpent",
  resolution: "resolution",
};

/** Best-guess target for a source header, or "" (unmapped). */
export function guessTarget(header: string): TargetFieldId | "" {
  const h = header.trim().toLowerCase();
  return HEADER_SYNONYMS[h] ?? "";
}

export type PriorityValue = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

/** Guess a Priority enum from a source priority string. */
export function guessPriority(raw: string): PriorityValue | "" {
  const v = raw.trim().toLowerCase();
  if (!v) return "";
  if (/(crit|block|highest|p0|urgent|sev\s*1)/.test(v)) return "CRITICAL";
  if (/(high|major|p1|sev\s*2)/.test(v)) return "HIGH";
  if (/(low|minor|trivial|p3|p4|lowest)/.test(v)) return "LOW";
  if (/(med|normal|p2|default)/.test(v)) return "MEDIUM";
  return "";
}

/**
 * Parse a Jira-style duration ("1w 2d 3h 30m", "90m", "2.5h") OR a raw seconds
 * integer into SECONDS. Returns null when unparseable/empty. Jira week = 5d,
 * day = 8h (Jira's default working-time scheme).
 */
export function parseDurationSeconds(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  // Pure number → already seconds (Jira CSV exports worklog in seconds).
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  // Otherwise the WHOLE string must be Jira-style duration tokens ("1w 2d 3h
  // 30m"). Anchoring rejects ISO-8601 ("P1D"), free text ("5 sundays"),
  // European decimals ("2,5h"), and negatives — which the old un-anchored scan
  // silently turned into plausible-but-wrong seconds.
  if (!/^(\s*\d+(?:\.\d+)?\s*[wdhms]\s*)+$/i.test(s)) return null;
  const units: Record<string, number> = {
    w: 5 * 8 * 3600,
    d: 8 * 3600,
    h: 3600,
    m: 60,
    s: 1,
  };
  const re = /(\d+(?:\.\d+)?)\s*([wdhms])/gi;
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    total += parseFloat(m[1]) * units[m[2].toLowerCase()];
  }
  return Math.round(total);
}

/** The POST contract shared by the wizard and the API route. */
export interface ImportValueMaps {
  /** source status text → board columnKey */
  status?: Record<string, string>;
  /** source type text → WorkItemType id */
  type?: Record<string, string>;
  /** source priority text → Priority enum */
  priority?: Record<string, PriorityValue>;
  /** source assignee text → member userId ("" = unassigned) */
  assignee?: Record<string, string>;
}

export interface ImportRequest {
  mode: "validate" | "commit";
  /** sourceHeader → TargetFieldId | IGNORE */
  mapping: Record<string, string>;
  valueMaps: ImportValueMaps;
  rows: Record<string, string>[];
  /** Fallbacks when a row's mapped value is blank/unmapped. */
  defaults: {
    columnKey: string;
    workItemTypeId: string;
    priority: PriorityValue;
  };
}

export interface ImportRowError {
  row: number; // 1-based source row
  message: string;
}

export interface ImportReport {
  total: number;
  willCreate: number;
  willUpdate: number; // matched an existing externalId
  skipped: number; // rows with blocking errors
  errors: ImportRowError[];
  /** Non-blocking issues the row imports DESPITE — e.g. an assignee token that
   *  matched no org member (dropped), or a Sprint that matched no interval.
   *  Surfaced at validate time so nothing disappears silently. */
  warnings?: ImportRowError[];
  /** committed only */
  created?: number;
  updated?: number;
  /** Sprints/intervals auto-created from unmatched Sprint columns (FR 1fe31122). */
  createdIntervals?: number;
}
