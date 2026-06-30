/**
 * Client-safe entity registry for the GENERIC importer (the non-work-item path).
 *
 * Each definition describes one importable PM entity: a stable `key`, a display
 * `label` + lucide `icon` name, the list of mappable `fields`, and a
 * `naturalKey` (the field(s) that anchor idempotency — a row whose natural key
 * already exists is SKIPPED, never updated).
 *
 * NO server-only imports here — this file is shared by the wizard (client) and
 * the server engine (src/lib/import/entity-import.ts). The server engine owns
 * the actual Prisma create shapes + tolerant value coercion; this file owns the
 * *contract* (what columns map to what fields) and the header auto-guesser.
 *
 * Work items deliberately do NOT live here — they keep their dedicated
 * value-mapped flow (src/lib/import/work-item-fields.ts + the work-items/import
 * route). This registry is for everything else.
 */

/** Sentinel mapping value meaning "don't import this column". */
export const IGNORE = "__ignore__";

/** Scalar kinds the coercer understands. */
export type ImportFieldKind = "text" | "date" | "number" | "int" | "bool" | "enum";

/** One mappable target field on an entity. */
export interface ImportField {
  /** Key on the entity's mapped row (also the create-data shape input). */
  key: string;
  /** Human label shown in the mapping UI. */
  label: string;
  /** A row missing this field is a per-row error (counted in `skipped`). */
  required?: boolean;
  kind: ImportFieldKind;
  /** Allowed enum values (Prisma enum labels) when `kind === "enum"`. */
  enum?: string[];
  /** Short hint shown under the mapping row. */
  hint?: string;
  /** Header synonyms (lowercased) for auto-mapping on upload. */
  synonyms?: string[];
}

/** A registered, importable entity (everything EXCEPT work items). */
export interface EntityDef {
  /** Stable key sent to the API as `entity`. */
  key: string;
  label: string;
  /** lucide-react icon name (rendered by the wizard's card grid). */
  icon: string;
  /** Short description for the entity-picker card. */
  blurb: string;
  fields: ImportField[];
  /** The field key(s) that anchor idempotency (create-or-skip). */
  naturalKey: string[];
}

// ── Shared enum value lists (mirror prisma/schema.prisma; the server coerces
//    tolerantly — case/space-insensitive — so "not started" → NOT_STARTED). ──
const DELIVERABLE_STATUS = [
  "NOT_STARTED", "DRAFT_IN_PROGRESS", "IN_PROGRESS", "INTERNAL_REVIEW",
  "SUBMITTED", "IN_GOVT_REVIEW", "ACCEPTED", "ACCEPTED_WITH_COMMENTS",
  "REJECTED", "REVISION_REQUIRED", "OVERDUE",
];
const RISK_STATUS = ["OPEN", "MONITORING", "MITIGATING", "MITIGATED", "CLOSED", "ESCALATED"];
const MILESTONE_STATUS = ["UPCOMING", "IN_PROGRESS", "COMPLETED", "MISSED"];
const OBJECTIVE_STATUS = ["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"];
const GOAL_STATUS = ["PLANNED", "ON_TRACK", "AT_RISK", "OFF_TRACK", "ACHIEVED"];
const GOAL_PROGRESS_MODE = ["MANUAL", "AUTO"];
const CYCLE_KIND = ["SPRINT", "PHASE", "MODULE", "RUN", "EVENT_DAY", "RELEASE", "ITERATION"];
const SPRINT_STATUS = ["PLANNED", "ACTIVE", "COMPLETED"];
const BLOCKER_TYPE = [
  "INTERNAL", "EXTERNAL_GOVERNMENT", "EXTERNAL_VENDOR",
  "EXTERNAL_PROCUREMENT", "EXTERNAL_THIRD_PARTY",
];
const BLOCKER_STATUS = ["OPEN", "RESOLVED", "IN_PROGRESS", "ESCALATED"];
const CHANGE_REQUEST_STATUS = [
  "SUBMITTED", "APPROVED", "REJECTED", "IMPLEMENTED", "UNDER_REVIEW", "WITHDRAWN",
];

// Reusable field fragments.
const code = (label = "Code"): ImportField => ({
  key: "code", label, required: true, kind: "text",
  hint: "Required, unique — anchors idempotent re-import.",
  synonyms: ["code", "id", "ref", "number", "no", "#"],
});
const title = (label = "Title"): ImportField => ({
  key: "title", label, required: true, kind: "text",
  synonyms: ["title", "name", "summary", "subject"],
});
const description: ImportField = {
  key: "description", label: "Description", kind: "text",
  synonyms: ["description", "desc", "details", "body", "notes/desc"],
};
const owner: ImportField = {
  key: "owner", label: "Owner", kind: "text",
  synonyms: ["owner", "assignee", "responsible", "poc", "lead"],
};
const notes: ImportField = {
  key: "notes", label: "Notes", kind: "text",
  synonyms: ["notes", "comment", "comments", "remarks"],
};

/**
 * The entity registry. Order = the order cards appear in the picker (after the
 * always-first "Work Items" card, which the wizard injects).
 */
export const ENTITY_DEFS: EntityDef[] = [
  {
    key: "deliverable",
    label: "Deliverables",
    icon: "PackageCheck",
    blurb: "CDRLs / deliverable register — code, due dates, status, owner.",
    naturalKey: ["code"],
    fields: [
      code("Deliverable code"),
      title("Title"),
      description,
      { key: "clin", label: "CLIN", kind: "text", synonyms: ["clin"] },
      { key: "deliverableType", label: "Type", kind: "text", synonyms: ["type", "deliverable type", "cdrl type"] },
      { key: "status", label: "Status", kind: "enum", enum: DELIVERABLE_STATUS, synonyms: ["status", "state"] },
      { key: "baselineDue", label: "Baseline due", kind: "date", synonyms: ["baseline due", "due", "due date", "baseline", "baseline date"] },
      { key: "internalReview", label: "Internal review", kind: "date", synonyms: ["internal review", "internal review date"] },
      { key: "actualSubmission", label: "Actual submission", kind: "date", synonyms: ["actual submission", "submitted", "submission date", "actual"] },
      { key: "govReviewPeriod", label: "Gov review period (days)", kind: "int", synonyms: ["gov review period", "government review period", "review period", "review days"] },
      { key: "govAcceptance", label: "Gov acceptance", kind: "date", synonyms: ["gov acceptance", "government acceptance", "accepted date", "acceptance"] },
      { key: "owner", label: "Owner", kind: "text", synonyms: owner.synonyms },
      { key: "branchOwner", label: "Branch owner", kind: "text", synonyms: ["branch owner", "branch", "domain", "domain lead"] },
      { key: "revisionCycle", label: "Revision cycle", kind: "int", synonyms: ["revision cycle", "rev cycle", "cycle", "revision"] },
      { key: "revRequired", label: "Revision required", kind: "bool", synonyms: ["rev required", "revision required", "rework"] },
      { key: "escalate", label: "Escalate", kind: "bool", synonyms: ["escalate", "escalated", "flag"] },
      { key: "workItemRef", label: "Work item ref", kind: "text", synonyms: ["work item ref", "cosmos reference", "cosmos ref", "work item", "linked item"] },
      { key: "notes", label: "Notes", kind: "text", synonyms: notes.synonyms },
    ],
  },
  {
    key: "risk",
    label: "Risks",
    icon: "ShieldAlert",
    blurb: "Risk register — likelihood × impact, mitigation, status (score auto-computed).",
    naturalKey: ["code"],
    fields: [
      code("Risk code"),
      title("Title"),
      description,
      { key: "category", label: "Category", kind: "text", synonyms: ["category", "type", "area"] },
      { key: "likelihood", label: "Likelihood (1-5)", kind: "int", synonyms: ["likelihood", "probability", "prob", "l"] },
      { key: "impact", label: "Impact (1-5)", kind: "int", synonyms: ["impact", "severity", "consequence", "i"] },
      { key: "owner", label: "Owner", kind: "text", synonyms: owner.synonyms },
      { key: "mitigation", label: "Mitigation", kind: "text", synonyms: ["mitigation", "mitigation plan", "response", "treatment"] },
      { key: "contingency", label: "Contingency", kind: "text", synonyms: ["contingency", "contingency plan", "fallback"] },
      { key: "status", label: "Status", kind: "enum", enum: RISK_STATUS, synonyms: ["status", "state"] },
      { key: "trend", label: "Trend", kind: "text", synonyms: ["trend", "direction"] },
      { key: "targetDate", label: "Target date", kind: "date", synonyms: ["target date", "due date", "due", "target", "resolve by"] },
    ],
  },
  {
    key: "milestone",
    label: "Milestones",
    icon: "Flag",
    blurb: "Schedule milestones / phase gates — title, due date, phase, status.",
    naturalKey: ["title"],
    fields: [
      title("Title"),
      description,
      { key: "dueDate", label: "Due date", required: true, kind: "date", synonyms: ["due date", "due", "date", "target date", "target"] },
      { key: "phase", label: "Phase", kind: "text", synonyms: ["phase", "stage", "gate"] },
      { key: "status", label: "Status", kind: "enum", enum: MILESTONE_STATUS, synonyms: ["status", "state"] },
      { key: "baselineDate", label: "Baseline date", kind: "date", synonyms: ["baseline date", "baseline", "planned date"] },
      { key: "notes", label: "Notes", kind: "text", synonyms: notes.synonyms },
    ],
  },
  {
    key: "clin",
    label: "CLINs",
    icon: "Receipt",
    blurb: "Contract line items — code, ceiling/funded value, period of performance.",
    naturalKey: ["code"],
    fields: [
      code("CLIN code"),
      title("Title"),
      { key: "value", label: "Value (ceiling)", kind: "number", synonyms: ["value", "ceiling", "ceiling value", "total value", "amount"] },
      { key: "fundedValue", label: "Funded value", kind: "number", synonyms: ["funded value", "funded", "obligated", "funding"] },
      { key: "popStart", label: "PoP start", kind: "date", synonyms: ["pop start", "period start", "start date", "start"] },
      { key: "popEnd", label: "PoP end", kind: "date", synonyms: ["pop end", "period end", "end date", "end"] },
      { key: "status", label: "Status", kind: "text", synonyms: ["status", "state"] },
    ],
  },
  {
    key: "objective",
    label: "Objectives (OKR)",
    icon: "Target",
    blurb: "OKR objectives — title, period, status.",
    naturalKey: ["title"],
    fields: [
      title("Title"),
      description,
      { key: "period", label: "Period", kind: "text", synonyms: ["period", "quarter", "cycle", "timeframe", "pi"] },
      { key: "status", label: "Status", kind: "enum", enum: OBJECTIVE_STATUS, synonyms: ["status", "state"] },
    ],
  },
  {
    key: "goal",
    label: "Goals",
    icon: "Goal",
    blurb: "Delivery goals — title, status, target date.",
    naturalKey: ["title"],
    fields: [
      title("Title"),
      description,
      { key: "status", label: "Status", kind: "enum", enum: GOAL_STATUS, synonyms: ["status", "state"] },
      { key: "targetDate", label: "Target date", kind: "date", synonyms: ["target date", "due date", "due", "target", "deadline"] },
      { key: "progressMode", label: "Progress mode", kind: "enum", enum: GOAL_PROGRESS_MODE, synonyms: ["progress mode", "mode", "tracking"] },
    ],
  },
  {
    key: "cycle",
    label: "Cycles / Sprints",
    icon: "RefreshCw",
    blurb: "Sprints / phases — name, dates, kind, status (number auto-assigned).",
    naturalKey: ["name"],
    fields: [
      { key: "name", label: "Name", required: true, kind: "text", synonyms: ["name", "sprint", "cycle", "title", "label", "iteration"] },
      { key: "goal", label: "Goal", kind: "text", synonyms: ["goal", "objective", "theme", "description"] },
      { key: "startDate", label: "Start date", required: true, kind: "date", synonyms: ["start date", "start", "begin", "from"] },
      { key: "endDate", label: "End date", required: true, kind: "date", synonyms: ["end date", "end", "finish", "to", "due"] },
      { key: "cycleKind", label: "Kind", kind: "enum", enum: CYCLE_KIND, synonyms: ["kind", "type", "cycle kind"] },
      { key: "status", label: "Status", kind: "enum", enum: SPRINT_STATUS, synonyms: ["status", "state"] },
    ],
  },
  {
    key: "blocker",
    label: "Blockers",
    icon: "OctagonAlert",
    blurb: "Blockers / impediments — code, type, status, what it unblocks.",
    naturalKey: ["code"],
    fields: [
      code("Blocker code"),
      title("Title"),
      description,
      { key: "type", label: "Type", kind: "enum", enum: BLOCKER_TYPE, synonyms: ["type", "category", "source type"] },
      { key: "status", label: "Status", kind: "enum", enum: BLOCKER_STATUS, synonyms: ["status", "state"] },
      { key: "whatUnblocks", label: "What it unblocks", kind: "text", synonyms: ["what unblocks", "unblocks", "blocking", "impact"] },
      { key: "owner", label: "Owner", kind: "text", synonyms: owner.synonyms },
      { key: "source", label: "Source", kind: "text", synonyms: ["source", "origin", "raised by"] },
      { key: "targetDate", label: "Target date", kind: "date", synonyms: ["target date", "due date", "due", "target", "resolve by"] },
      { key: "notes", label: "Notes", kind: "text", synonyms: notes.synonyms },
    ],
  },
  {
    key: "changeRequest",
    label: "Change Requests",
    icon: "GitPullRequestArrow",
    blurb: "Change requests — code, type, status, cost/schedule impact.",
    naturalKey: ["code"],
    fields: [
      code("CR code"),
      title("Title"),
      description,
      { key: "type", label: "Type", kind: "text", synonyms: ["type", "category", "class"] },
      { key: "status", label: "Status", kind: "enum", enum: CHANGE_REQUEST_STATUS, synonyms: ["status", "state"] },
      { key: "initiatedBy", label: "Initiated by", kind: "text", synonyms: ["initiated by", "requestor", "requester", "submitted by", "owner"] },
      { key: "costImpact", label: "Cost impact", kind: "number", synonyms: ["cost impact", "cost", "$ impact", "dollar impact"] },
      { key: "scheduleDaysImpact", label: "Schedule impact (days)", kind: "int", synonyms: ["schedule days impact", "schedule impact", "days impact", "schedule days"] },
      { key: "notes", label: "Notes", kind: "text", synonyms: notes.synonyms },
    ],
  },
  {
    key: "vendor",
    label: "Vendors / Subs",
    icon: "Handshake",
    blurb: "Subcontractors / vendor agreements — partner + contract value, dates.",
    naturalKey: ["agmtNumber", "title"],
    fields: [
      { key: "partnerName", label: "Partner / vendor name", required: true, kind: "text", synonyms: ["partner name", "vendor", "vendor name", "partner", "company", "subcontractor", "sub"] },
      { key: "title", label: "Agreement title", required: true, kind: "text", synonyms: ["title", "agreement", "agreement title", "name", "contract", "contract name"] },
      { key: "value", label: "Value (ceiling)", kind: "number", synonyms: ["value", "ceiling", "total value", "amount", "contract value"] },
      { key: "fundedValue", label: "Funded value", kind: "number", synonyms: ["funded value", "funded", "obligated", "funding"] },
      { key: "agmtType", label: "Agreement type", kind: "text", synonyms: ["agmt type", "agreement type", "type", "vehicle"] },
      { key: "agmtNumber", label: "Agreement number", kind: "text", synonyms: ["agmt number", "agreement number", "number", "po number", "po", "contract number"] },
      { key: "status", label: "Status", kind: "text", synonyms: ["status", "state"] },
      { key: "startDate", label: "Start date", kind: "date", synonyms: ["start date", "start", "pop start", "begin"] },
      { key: "endDate", label: "End date", kind: "date", synonyms: ["end date", "end", "pop end", "finish"] },
    ],
  },
];

/** Look up an entity definition by key. */
export function getEntityDef(key: string): EntityDef | undefined {
  return ENTITY_DEFS.find((e) => e.key === key);
}

/**
 * Best-guess field key for a source header, or "" (unmapped). Mirrors the
 * synonym approach in work-item-fields.ts: exact match on the lowercased header
 * against each field's synonyms (or its key/label). First field wins.
 */
export function guessFieldForHeader(entity: EntityDef, header: string): string {
  const h = header.trim().toLowerCase();
  if (!h) return "";
  for (const f of entity.fields) {
    if (f.key.toLowerCase() === h) return f.key;
    if (f.label.toLowerCase() === h) return f.key;
    if (f.synonyms?.some((s) => s.toLowerCase() === h)) return f.key;
  }
  return "";
}

// ── The POST contract shared by the generic wizard and the API route. ──

export interface EntityImportRequest {
  entity: string;
  mode: "validate" | "commit";
  /** sourceHeader → fieldKey | IGNORE */
  mapping: Record<string, string>;
  rows: Record<string, string | number | null>[];
}

export interface EntityImportRowError {
  row: number; // 1-based source row
  message: string;
}

export interface EntityImportReport {
  total: number;
  willCreate: number;
  skipped: number;
  errors: EntityImportRowError[];
  /** committed only */
  created?: number;
}
