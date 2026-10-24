/**
 * Two-phase sort (query design §6.4) for orderings Prisma can't express:
 * the assignee's name, the status name, the project key and custom fields.
 *
 *   1. The ids the scoped where matches, refused past SORT_MAX
 *      (CQL_SORT_TOO_BROAD) rather than sorting an unbounded set.
 *   2. One parameterized statement orders those ids and returns a page.
 *   3. The caller hydrates the page by id and keeps this order.
 *
 * As in history.server.ts, every expression is a constant fragment keyed by
 * the closed field union, and every value (custom field keys included) is a
 * bound parameter.
 */
import { Prisma } from "@prisma/client";
import type { SystemFieldId } from "./fields";
import type { SqlSortKey } from "./env";
import { CqlError, diag } from "./errors";

/** Custom sorts order at most this many matching items. */
export const SORT_MAX = 10_000;

type Db = Pick<Prisma.TransactionClient, "$queryRaw" | "workItem">;

/** Each sortable system field as an SQL expression over `w` (work_items). */
const SYS: Partial<Record<SystemFieldId, Prisma.Sql>> = {
  key: Prisma.sql`w.ticket_number`,
  created: Prisma.sql`w.created_at`,
  updated: Prisma.sql`w.updated_at`,
  due: Prisma.sql`w.due_date`,
  start: Prisma.sql`w.start_date`,
  actualStart: Prisma.sql`w.actual_start`,
  completed: Prisma.sql`w.completed_at`,
  statusChanged: Prisma.sql`w.column_entered_at`,
  archivedAt: Prisma.sql`w.archived_at`,
  points: Prisma.sql`w.story_points`,
  originalEstimate: Prisma.sql`w.original_estimate`,
  remainingEstimate: Prisma.sql`w.remaining_estimate`,
  timeSpent: Prisma.sql`w.time_spent`,
  rank: Prisma.sql`w.sort_order`,
  // Declared CRITICAL → LOW, so ASC is most urgent first, as elsewhere.
  priority: Prisma.sql`w.priority`,
  type: Prisma.sql`(SELECT lower(t.name) FROM work_item_types t WHERE t.id = w.work_item_type_id)`,
  // The primary assignee, by name.
  assignee: Prisma.sql`(SELECT lower(u.display_name) FROM users u WHERE u.id = w.assignee_id)`,
  // The status's name in the item's project: workflow_statuses is where a
  // status lives (one per project and key), as the resolver reads it.
  status: Prisma.sql`(SELECT lower(s.name) FROM workflow_statuses s WHERE s.project_id = w.project_id AND s.key = w.column_key)`,
  project: Prisma.sql`(SELECT p.key FROM projects p WHERE p.id = w.project_id)`,
};

function expr(k: SqlSortKey): Prisma.Sql | null {
  if (k.field.kind === "sys") return SYS[k.field.id] ?? null;
  const key = k.field.key;
  switch (k.cfType) {
    case "NUMBER":
      // A value that isn't a JSON number sorts as empty, never as an error.
      return Prisma.sql`(CASE WHEN jsonb_typeof(w.custom_fields -> ${key}) = 'number' THEN (w.custom_fields ->> ${key})::numeric END)`;
    case "DATE":
      // Stored as YYYY-MM-DD, which orders correctly as text.
      return Prisma.sql`NULLIF(w.custom_fields ->> ${key}, '')`;
    case "TEXT":
    case "URL":
    case "EMAIL":
    case "SELECT":
      return Prisma.sql`NULLIF(lower(w.custom_fields ->> ${key}), '')`;
    default:
      return null;
  }
}

function orderSql(keys: SqlSortKey[]): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  for (const k of keys) {
    const e = expr(k);
    if (!e) continue;
    const dir = k.dir === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`;
    const nulls = k.nulls === "first" ? Prisma.sql`NULLS FIRST` : Prisma.sql`NULLS LAST`;
    parts.push(Prisma.sql`${e} ${dir} ${nulls}`);
  }
  // The same stable tiebreak as compileOrderBy.
  parts.push(Prisma.sql`w.created_at DESC`, Prisma.sql`w.id DESC`);
  return Prisma.join(parts, ", ");
}

/** The page of ids, in order. `where` is the full scoped where. */
export async function sortedIds(
  db: Db,
  where: Prisma.WorkItemWhereInput,
  keys: SqlSortKey[],
  page: { skip: number; take: number },
  /** How many matching items may be ordered: SORT_MAX for a page, more for an export. */
  max = SORT_MAX,
): Promise<string[]> {
  const matching = await db.workItem.findMany({ where, select: { id: true }, take: max + 1 });
  if (matching.length > max) {
    throw new CqlError(
      [
        diag(
          "",
          "CQL_SORT_TOO_BROAD",
          `Sorting by assignee, status, project or a custom field works on up to ${max.toLocaleString("en-US")} items. Narrow the query, or sort by another field.`,
        ),
      ],
      422,
    );
  }
  if (matching.length === 0) return [];
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT w.id::text AS id FROM work_items w
     WHERE w.id = ANY(${matching.map((m) => m.id)}::uuid[])
     ORDER BY ${orderSql(keys)}
     LIMIT ${page.take} OFFSET ${page.skip}`;
  return rows.map((r) => r.id);
}

/** Put hydrated rows back in the sorted order. */
export function inOrder<T extends { id: string }>(ids: string[], rows: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is T => !!r);
}
