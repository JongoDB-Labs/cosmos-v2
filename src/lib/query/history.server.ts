/**
 * History prefilters (query design §3.6, §6.3): the `WAS` / `CHANGED` clauses
 * Prisma can't express, answered as id sets over `activities`.
 *
 * Every statement is a tagged template: values are bound parameters, and the
 * only identifiers are the constant column expressions below, keyed by the
 * closed `HistoryField` union. Each one embeds the org and readable-project
 * scope and is bounded by TOO_BROAD.
 */
import { Prisma } from "@prisma/client";
import { TOO_BROAD, tooBroad } from "./errors";
import { HISTORY, historyKey, type HistoryField, type HistorySpec, type HistoryValueSet } from "./history";

type Db = Pick<Prisma.TransactionClient, "$queryRaw">;

/** Each field's current value as text, in the format Activity stores it. */
const CURRENT: Record<HistoryField, Prisma.Sql> = {
  status: Prisma.sql`w.column_key`,
  priority: Prisma.sql`w.priority::text`,
  assignee: Prisma.sql`w.assignee_id::text`,
  sprint: Prisma.sql`w.interval_id::text`,
  team: Prisma.sql`w.team_id::text`,
  type: Prisma.sql`w.work_item_type_id::text`,
  // Date columns are UTC timestamps without a zone; Activity stores toISOString().
  due: Prisma.sql`to_char(w.due_date, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  start: Prisma.sql`to_char(w.start_date, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  completed: Prisma.sql`to_char(w.completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
};

/** A stored value as an instant, or NULL when it isn't a date (never an error). */
const asInstant = (v: Prisma.Sql) =>
  Prisma.sql`(CASE WHEN ${v} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (${v})::timestamptz END)`;

/** `v` (a text expression) matches the set. */
function matches(v: Prisma.Sql, set: HistoryValueSet): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (set.values.length) parts.push(Prisma.sql`${v} = ANY(${set.values}::text[])`);
  if (set.empty) parts.push(Prisma.sql`${v} IS NULL`);
  if (set.ranges.length) {
    const t = asInstant(v);
    parts.push(Prisma.sql`EXISTS (
      SELECT 1 FROM unnest(${set.ranges.map((r) => r.from)}::timestamptz[], ${set.ranges.map((r) => r.to)}::timestamptz[]) AS r(lo, hi)
      WHERE ${t} >= r.lo AND ${t} < r.hi)`);
  }
  return parts.length ? Prisma.sql`(${Prisma.join(parts, " OR ")})` : Prisma.sql`FALSE`;
}

/**
 * `held`: value intervals per item. Each recorded change closes the previous
 * value and opens the next; the first change's old value runs from the item's
 * creation, and the last segment is the CURRENT column value, so a write that
 * wasn't recorded can't leave an item holding a value it no longer has. An
 * item with no recorded change has held its current value since creation.
 */
function heldSql(spec: Extract<HistorySpec, { kind: "held" }>, orgId: string, readable: string[]): Prisma.Sql {
  const field = HISTORY[spec.field].activity;
  const lo = spec.from ? Prisma.sql`seg.t > ${spec.from}::timestamptz` : Prisma.sql`TRUE`;
  const hi = spec.to ? Prisma.sql`seg.f < ${spec.to}::timestamptz` : Prisma.sql`TRUE`;
  return Prisma.sql`
    WITH scope AS (
      SELECT w.id, w.created_at AT TIME ZONE 'UTC' AS born, ${CURRENT[spec.field]} AS cur
        FROM work_items w
       WHERE w.org_id = ${orgId}::uuid AND w.project_id = ANY(${readable}::uuid[])
    ),
    acts AS (
      SELECT a.work_item_id AS id, a.created_at AT TIME ZONE 'UTC' AS at, a.old_value, a.new_value,
             ROW_NUMBER() OVER (PARTITION BY a.work_item_id ORDER BY a.created_at, a.id) AS rn,
             LEAD(a.created_at AT TIME ZONE 'UTC') OVER (PARTITION BY a.work_item_id ORDER BY a.created_at, a.id) AS next_at
        FROM activities a
        JOIN scope s ON s.id = a.work_item_id
       WHERE a.org_id = ${orgId}::uuid AND a.action = 'updated' AND a.field = ${field}
    ),
    last AS (SELECT id, max(at) AS at FROM acts GROUP BY id),
    seg(id, v, f, t) AS (
      SELECT a.id, a.old_value, s.born, a.at FROM acts a JOIN scope s ON s.id = a.id WHERE a.rn = 1
      UNION ALL
      SELECT id, new_value, at, next_at FROM acts WHERE next_at IS NOT NULL
      UNION ALL
      SELECT s.id, s.cur, COALESCE(l.at, s.born), 'infinity'::timestamptz FROM scope s LEFT JOIN last l ON l.id = s.id
    )
    SELECT DISTINCT seg.id::text AS id FROM seg
     WHERE ${matches(Prisma.sql`seg.v`, spec.set)} AND ${lo} AND ${hi}
     LIMIT ${TOO_BROAD}`;
}

/** `changed`: Activity rows whose values only a time comparison can match. */
function changedSql(spec: Extract<HistorySpec, { kind: "changed" }>, orgId: string, readable: string[]): Prisma.Sql {
  const at = Prisma.sql`(a.created_at AT TIME ZONE 'UTC')`;
  const conds: Prisma.Sql[] = [
    ...(spec.old ? [matches(Prisma.sql`a.old_value`, spec.old)] : []),
    ...(spec.new ? [matches(Prisma.sql`a.new_value`, spec.new)] : []),
    ...(spec.by ? [Prisma.sql`a.user_id = ANY(${spec.by}::uuid[])`] : []),
    ...(spec.from ? [Prisma.sql`${at} >= ${spec.from}::timestamptz`] : []),
    ...(spec.to ? [Prisma.sql`${at} < ${spec.to}::timestamptz`] : []),
  ];
  return Prisma.sql`
    SELECT DISTINCT a.work_item_id::text AS id
      FROM activities a
      JOIN work_items w ON w.id = a.work_item_id
     WHERE a.org_id = ${orgId}::uuid AND w.org_id = ${orgId}::uuid AND w.project_id = ANY(${readable}::uuid[])
       AND a.action = 'updated' AND a.field = ${HISTORY[spec.field].activity}
       ${conds.length ? Prisma.sql`AND ${Prisma.join(conds, " AND ")}` : Prisma.empty}
     LIMIT ${TOO_BROAD}`;
}

export function historySql(spec: HistorySpec, orgId: string, readable: string[]): Prisma.Sql {
  return spec.kind === "held" ? heldSql(spec, orgId, readable) : changedSql(spec, orgId, readable);
}

/** Run each prefilter once; results keyed for `CompileEnv.history`. */
export async function runHistoryPrefilters(
  db: Db,
  specs: HistorySpec[],
  orgId: string,
  readable: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (readable.length === 0) {
    for (const s of specs) out.set(historyKey(s), []);
    return out;
  }
  for (const spec of specs) {
    const rows = await db.$queryRaw<{ id: string }[]>(historySql(spec, orgId, readable));
    if (rows.length >= TOO_BROAD) throw tooBroad("history");
    out.set(historyKey(spec), rows.map((r) => r.id));
  }
  return out;
}
