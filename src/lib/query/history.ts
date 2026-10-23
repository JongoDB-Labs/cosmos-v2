/**
 * History clauses (`WAS`, `CHANGED`) over the `Activity` rows the work-item
 * writers record (query design §3.6). Pure: the field map and the shape of a
 * raw-SQL prefilter. compile.ts decides which clauses need one,
 * history.server.ts runs them, and the results arrive in `CompileEnv.history`.
 */
import { stableStringify } from "./normalize";

/**
 * The fields history can query, each with the `Activity.field` the writers
 * record it under and the `WorkItem` column that holds its current value.
 * `kind: "date"` values are ISO instants, compared as time; the others are
 * compared as the stored strings (column keys, enum names, uuids).
 * `nullable` is the column's: only nullable columns can be EMPTY.
 */
export const HISTORY = {
  status: { activity: "columnKey", column: "columnKey", kind: "id", nullable: false },
  priority: { activity: "priority", column: "priority", kind: "enum", nullable: false },
  // The primary assignee only: co-assignee changes aren't recorded.
  assignee: { activity: "assigneeId", column: "assigneeId", kind: "id", nullable: true },
  sprint: { activity: "intervalId", column: "intervalId", kind: "id", nullable: true },
  team: { activity: "teamId", column: "teamId", kind: "id", nullable: true },
  type: { activity: "workItemTypeId", column: "workItemTypeId", kind: "id", nullable: false },
  due: { activity: "dueDate", column: "dueDate", kind: "date", nullable: true },
  start: { activity: "startDate", column: "startDate", kind: "date", nullable: true },
  completed: { activity: "completedAt", column: "completedAt", kind: "date", nullable: true },
} as const;

export type HistoryField = keyof typeof HISTORY;

export function isHistoryColumn(id: string): id is HistoryField {
  return Object.prototype.hasOwnProperty.call(HISTORY, id);
}

/** Values a history clause matches, as Activity stores them. */
export interface HistoryValueSet {
  /** Exact strings: column keys, enum names, uuids. */
  values: string[];
  /** Date fields: [from, to) as ISO instants. */
  ranges: { from: string; to: string }[];
  /** EMPTY: the stored value is null. */
  empty: boolean;
}

/**
 * A clause Prisma can't express, answered by an id prefilter:
 * - `held`: the item held one of the values at some instant in [from, to)
 *   (`WAS … AFTER/BEFORE/ON/DURING`, and every `WAS` on a date field);
 * - `changed`: an Activity row with old / new values that only a time
 *   comparison can match (`due CHANGED FROM … TO …`).
 * Instants are ISO strings, so a spec is its own stable cache key.
 */
export type HistorySpec =
  | { kind: "held"; field: HistoryField; set: HistoryValueSet; from: string | null; to: string | null }
  | {
      kind: "changed";
      field: HistoryField;
      old?: HistoryValueSet;
      new?: HistoryValueSet;
      by?: string[];
      from: string | null;
      to: string | null;
    };

export function historyKey(spec: HistorySpec): string {
  return stableStringify(spec);
}
