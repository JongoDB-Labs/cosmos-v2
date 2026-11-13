/**
 * What a board saved from a query stores in `Board.config`.
 *
 * "Save as board" (the Issues view's dialog) and the assistant's `create_board`
 * both turn a query into a board, so the shape is decided here, once. A board
 * is a view over a query: `config.query` is its baseline, and `config.savedFilter`
 * is the same scope in the legacy shape, written only when that shape can say it
 * (`boardScope` in saved-filter.ts reads it when the query language is off).
 *
 * Pure: imported by a client component and by the server.
 */
import { CQL_VERSION, type CqlNode, type CqlQuery } from "@/lib/query/ast";
import { toWorkItemFilter } from "@/lib/query/adapters";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";

const isProjectClause = (n: CqlNode) => (n.op === "cmp" || n.op === "in") && n.field.kind === "sys" && n.field.id === "project";

/**
 * A query without its top-level project clauses (`project = X AND …`). The
 * board pins its own project, so a stored `project = X` would only empty a
 * board created in another one.
 */
export function withoutProjectClauses(q: CqlQuery): CqlQuery {
  const w = q.where;
  let where: CqlNode | null = w;
  if (w && isProjectClause(w)) where = null;
  else if (w?.op === "and") {
    const args = w.args.filter((a) => !isProjectClause(a));
    where = args.length === 0 ? null : args.length === 1 ? args[0] : { op: "and", args };
  }
  return { v: CQL_VERSION, where, ...(q.orderBy ? { orderBy: q.orderBy } : {}) };
}

/**
 * The `config` for a board whose baseline is `query` (already resolved). The
 * legacy `savedFilter` rides along only when `toWorkItemFilter` can say the
 * query; otherwise it is left out, and a viewer without the query language sees
 * the board refuse to widen rather than show everything.
 */
export function boardConfigFromQuery(
  query: CqlQuery,
  cfTypes: ReadonlyMap<string, string> = new Map(),
): { query: CqlQuery; savedFilter?: WorkItemFilter } {
  const legacy = toWorkItemFilter(query, cfTypes);
  let savedFilter: WorkItemFilter | undefined;
  if (legacy) {
    savedFilter = { ...legacy };
    delete savedFilter.projectIds;
  }
  return { query: withoutProjectClauses(query), ...(savedFilter ? { savedFilter } : {}) };
}
