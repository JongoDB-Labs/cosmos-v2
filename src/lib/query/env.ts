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

/** One team, as the team rule needs it: where it lives and who is on it. */
export interface TeamRoster {
  projectId: string;
  /** Sorted, distinct. */
  userIds: string[];
}

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
  /**
   * The projects this actor may read items from. Set ONLY when the query names
   * `hasChildren`.
   *
   * compile.ts emits no scope of its own — execute.server.ts wraps its output
   * in `buildScopedWhere`, and an arch test proves orgId never appears here.
   * But that envelope only constrains the OUTER row: a NESTED relation filter
   * such as `{ children: { some: … } }` is evaluated against every child row in
   * the database, scoped or not. So "does this item have a sub-item" would
   * otherwise answer yes on the strength of a child in a project the actor
   * cannot read. Same disclosure shape as `documentVisibility` above, and
   * handled the same way: absent means refuse, never a bare relation filter.
   */
  readableProjectIds?: string[];
  /**
   * Every readable team by id: its project and the user ids on it. Set ONLY
   * when the query names `team`.
   *
   * `team = X` follows the team rule the board's filter bar, its swimlanes and
   * Cosmo's team filter already use (lib/teams/item-teams.ts): an item that
   * names X, or one that names no team and whose primary assignee is on X, in
   * X's project. The roster is the second half of that rule. Absent means the
   * compiler refuses the field, because the only fallback is the item's own
   * column, which leaves out every item nobody tagged with a team.
   */
  teamRosters?: ReadonlyMap<string, TeamRoster>;
  /**
   * The comments this actor may read, for every field that reads comment text
   * (`mentions`, `comment`, `text`; see COMMENT_TEXT_FIELDS): the readable
   * projects whose comments pass the comment thread's own gate (COMMENT_READ),
   * and the fragment every comment read applies (`readableCommentsWhere`:
   * public, neither deleted nor hidden, marked within the org's ceiling). Set
   * ONLY when the query names one of those fields.
   *
   * Same shape as `readableProjectIds`: `comments.some` is a nested filter the
   * scope envelope does not reach (it decides which items, not which of their
   * comments), so a bare one would match an item through an internal, deleted
   * or hidden comment the actor can't open. Absent means refuse.
   */
  readableComments?: { projectIds: string[]; where: Prisma.CommentWhereInput };
  contextProjectId?: string;
  sinceLastStandup?: Date;
}

/**
 * Every field that reads comment text. Each compiles to a `comments.some` the
 * scope envelope does not reach, so each needs `readableComments`: the
 * resolver loads it when a query names any of them, the compiler refuses any
 * of them without it.
 */
export const COMMENT_TEXT_FIELDS = ["mentions", "comment", "text"] as const;

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
