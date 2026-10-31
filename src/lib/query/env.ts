/**
 * What a query's functions and variables mean at the moment it runs: the
 * bridge between the DB-backed resolver and the pure compiler. Kept apart from
 * compile.ts so that only execute.server.ts imports the compiler (arch test).
 */
// Type-only, so nothing from @prisma/client reaches the browser bundle: this
// module is on the client-safe list the CQL arch test enforces.
import type { Prisma } from "@prisma/client";
import type { CqlValue, FieldRef } from "./ast";
import type { CustomFieldType } from "./typecheck";
import { stableStringify } from "./normalize";

export type StatusCategory = "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";

export interface CompileEnv {
  actorUserId: string;
  now: Date;
  tz: string;
  /** Set-valued functions expanded to ids, keyed by `fnKey(fn)`. */
  fnIds: Map<string, string[]>;
  /** Variable values, already resolved for the field they are used with; null = unset (inert). */
  vars: Map<string, CqlValue[] | null>;
  /** Readable projects' column keys per category. */
  statusCategories: Record<StatusCategory, { projectId: string; keys: string[] }[]>;
  /** Items referenced by key comparisons (`key > ACME-100`). */
  items: Map<string, { projectId: string; ticketNumber: number }>;
  /** Custom field types by key. */
  customFields: Map<string, CustomFieldType>;
  /** Everything under an item (readable projects only), by the item's id: `ancestor`, `descendantsOf()`. */
  descendants: Map<string, string[]>;
  /** Items linked to each milestone the query names. */
  milestoneItems: Map<string, string[]>;
  /** Every item linked to any readable milestone (for `milestone IS EMPTY`). */
  milestoneLinked: string[];
  /** History prefilter results, by `historyKey(spec)` (see history.ts). */
  history: Map<string, string[]>;
  /**
   * Which FILES this actor may know the existence of: the same `where` fragment
   * the documents list uses (`documentVisibilityWhere` in lib/files/access.ts),
   * resolved against their AuthContext by resolve.server.ts.
   *
   * Optional, and set ONLY when the query names `hasAttachments` — it costs a
   * project-visibility read. Absent means the compiler must refuse the field
   * rather than fall back to a bare `{ documents: { some: {} } }`, which would
   * disclose that a restricted file exists. compile.ts throws; see the case
   * there for why there is no safe default.
   */
  documentVisibility?: Prisma.DocumentWhereInput;
  contextProjectId?: string;
  sinceLastStandup?: Date;
}

export function fnKey(v: Extract<CqlValue, { t: "fn" }>): string {
  return stableStringify({ name: v.name, args: v.args });
}

export function varKey(name: string, field: FieldRef): string {
  return `${name}@${field.kind === "sys" ? field.id : `cf:${field.key}`}`;
}


/**
 * The field a history clause's BY is typed and resolved as: people. Dashboard
 * variables in BY resolve under this key.
 */
export const HISTORY_BY_FIELD: FieldRef = { kind: "sys", id: "assignee" };

/** One ORDER BY key for the SQL sort (compile.ts → sort.server.ts). */
export type SqlSortKey = {
  field: FieldRef;
  dir: "asc" | "desc";
  nulls: "first" | "last";
  /** Custom fields: the type, which decides how the JSON value compares. */
  cfType?: CustomFieldType;
};
