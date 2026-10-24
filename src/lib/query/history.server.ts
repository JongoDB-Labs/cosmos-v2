/**
 * The history prefilter (query design §3.6, §6.3): the one part of a timed
 * `WAS` Prisma can't express, answered as an id set over `activities`.
 *
 * A tagged template: values are bound parameters and the field name is
 * looked up in the closed `HISTORY` map. It embeds the org and
 * readable-project scope and is bounded by ID_SET_MAX.
 */
import { Prisma } from "@prisma/client";
import { ID_SET_MAX, tooBroad } from "./errors";
import { HISTORY, historyKey, type HistorySpec, type HistoryValueSet } from "./history";

type Db = Pick<Prisma.TransactionClient, "$queryRaw">;

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
 * The items that held a value in the set when the window opened, or were set
 * to one by a recorded change inside the window. Its value when the window
 * opened is the old value of its first recorded change after that (the change
 * started from it). Both halves scan only Activity rows from the window on,
 * by (org, field, time), so the set is bounded
 * by the window's activity, not by the number of items.
 */
export function historySql(spec: HistorySpec, orgId: string, readable: string[]): Prisma.Sql {
  const field = HISTORY[spec.field].activity;
  // activities.created_at and work_items.created_at are UTC timestamps without a zone.
  const naive = (iso: string) => Prisma.sql`(${iso}::timestamptz AT TIME ZONE 'UTC')`;
  if (!spec.from && spec.to) return firstChangeSql(spec, field, orgId, readable, naive(spec.to));
  const after = spec.from ? Prisma.sql`a.created_at > ${naive(spec.from)}` : Prisma.sql`TRUE`;
  const inWindow = Prisma.join(
    [
      ...(spec.from ? [Prisma.sql`a.created_at >= ${naive(spec.from)}`] : []),
      ...(spec.to ? [Prisma.sql`a.created_at < ${naive(spec.to)}`] : []),
      Prisma.sql`TRUE`,
    ],
    " AND ",
  );
  const born = spec.to ? Prisma.sql`w.created_at < ${naive(spec.to)}` : Prisma.sql`TRUE`;
  return Prisma.sql`
    WITH opening AS (
      SELECT DISTINCT ON (a.work_item_id) a.work_item_id AS id, a.old_value AS v
        FROM activities a
       WHERE a.org_id = ${orgId}::uuid AND a.field = ${field} AND a.action = 'updated' AND ${after}
       ORDER BY a.work_item_id, a.created_at, a.id
    ),
    hits AS (
      SELECT o.id FROM opening o WHERE ${matches(Prisma.sql`o.v`, spec.set)}
      UNION
      SELECT a.work_item_id FROM activities a
       WHERE a.org_id = ${orgId}::uuid AND a.field = ${field} AND a.action = 'updated' AND ${inWindow}
         AND ${matches(Prisma.sql`a.new_value`, spec.set)}
    )
    SELECT w.id::text AS id
      FROM hits h
      JOIN work_items w ON w.id = h.id
     WHERE w.org_id = ${orgId}::uuid AND w.project_id = ANY(${readable}::uuid[]) AND ${born}
     LIMIT ${ID_SET_MAX + 1}`;
}

/**
 * BEFORE with no lower bound (compile.ts covers changes before the window
 * closed itself): the items whose FIRST recorded change of the field came at
 * or after `closed` and started from a value in the set, so they held it from
 * before the window closed. Scans only the activity since `closed`; "first"
 * is an anti-join on (work_item_id, field, created_at), not a sort of the
 * org's history.
 */
function firstChangeSql(spec: HistorySpec, field: string, orgId: string, readable: string[], closed: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT w.id::text AS id
      FROM activities a
      JOIN work_items w ON w.id = a.work_item_id
     WHERE a.org_id = ${orgId}::uuid AND a.field = ${field} AND a.action = 'updated' AND a.created_at >= ${closed}
       AND ${matches(Prisma.sql`a.old_value`, spec.set)}
       AND NOT EXISTS (
         SELECT 1 FROM activities b
          WHERE b.work_item_id = a.work_item_id AND b.field = a.field AND b.action = 'updated'
            AND (b.created_at, b.id) < (a.created_at, a.id))
       AND w.org_id = ${orgId}::uuid AND w.project_id = ANY(${readable}::uuid[]) AND w.created_at < ${closed}
     LIMIT ${ID_SET_MAX + 1}`;
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
    if (rows.length > ID_SET_MAX) throw tooBroad("history");
    out.set(historyKey(spec), rows.map((r) => r.id));
  }
  return out;
}
