"use client";

/**
 * A board's filter with the query language on (query design §12.1).
 *
 * A board is a view over a query. Its BASELINE is what the board is about:
 * the query it was saved with (`Board.config.query`; a board saved before
 * CQL keeps `config.savedFilter`, read through the lossless adapter) and, on
 * a sprint board, its sprint. The user's query from the bar (`?cql=`) is
 * ANDed onto it, and "Clear" returns to the baseline.
 *
 * The board already holds its project's rows, so the query is decided in the
 * browser: the server compiles it once (`POST cql/predicate`) and
 * lib/query/evaluate.ts interprets that predicate per row, so a dragged card
 * is re-judged instantly. Rows the predicate can't be decided on (it needs
 * comments, watchers, label ids, history…) are settled by the server's ids
 * (`POST work-items/query` with `idsOnly`), one request per query.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { parseCql } from "@/lib/query/parser";
import { printCql } from "@/lib/query/print";
import { hashQuery, validateAst } from "@/lib/query/normalize";
import { fromWorkItemFilter } from "@/lib/query/adapters";
import { UNDECIDED, matches } from "@/lib/query/evaluate";
import { CQL_VERSION, type CqlNode, type CqlQuery } from "@/lib/query/ast";
import type { CqlDiagnostic } from "@/lib/query/errors";
import type { WorkItemFilter } from "@/lib/work-items/query/filter";
import { useCqlSchema, useCqlUrlState, useCqlValidate, viewerTimeZone, type CqlClientSchema, type QueryMode } from "@/components/work-items/cql/use-cql";

const ref = (field: "project" | "sprint", entity: "project" | "interval", id: string, label?: string): CqlNode => ({
  op: "cmp",
  field: { kind: "sys", id: field },
  cmp: "eq",
  value: { t: "ref", entity, id, ...(label ? { label } : {}) },
});

const and = (...nodes: (CqlNode | null | undefined)[]): CqlNode | null => {
  const args = nodes.filter((n): n is CqlNode => !!n);
  return args.length === 0 ? null : args.length === 1 ? args[0] : { op: "and", args };
};

/**
 * What the board is about, from its config: the stored query, else a pre-CQL
 * saved filter, and the sprint a sprint board is scoped to. Null = everything.
 */
export function boardBaseline(
  config: unknown,
  sprint?: { id: string; name?: string } | null,
): { query: CqlQuery | null; problem?: string } {
  const c = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
  let stored: CqlNode | null = null;
  let problem: string | undefined;
  if (c.query != null) {
    const v = validateAst(c.query);
    if (v.query) stored = v.query.where;
    // Never widen: an unreadable scope shows nothing, and says so.
    else problem = "its saved query is not in a format this board can read";
  } else if (c.savedFilter != null && typeof c.savedFilter === "object") {
    // The board pins its own project, so a stored project list is moot.
    const filter = { ...(c.savedFilter as WorkItemFilter) };
    delete filter.projectIds;
    stored = fromWorkItemFilter(filter).where;
  }
  const where = and(stored, sprint ? ref("sprint", "interval", sprint.id, sprint.name) : null);
  return { query: where ? { v: CQL_VERSION, where } : null, ...(problem ? { problem } : {}) };
}

export interface BoardQuery {
  /** The org has the query language on (else the board keeps its legacy bar). */
  enabled: boolean;
  /** Is this row on the board? */
  keep: (row: { id: string }) => boolean;
  /** Still deciding (the predicate or the server's ids are loading). */
  pending: boolean;
  /** The board's own scope, as text, for the bar to show; null = everything. */
  baselineCql: string | null;
  /** Why this board shows nothing, when its saved scope can't be read. */
  problem: string | null;
  /** For the bar. */
  schema: CqlClientSchema | null;
  cql: string;
  /** The query, and the mode in the same navigation when the bar asks for one. */
  setCql: (cql: string, mode?: QueryMode) => void;
  mode: QueryMode | null;
  setMode: (mode: QueryMode) => void;
  diagnostics: CqlDiagnostic[];
}

export function useBoardQuery(opts: {
  orgId: string;
  projectId: string;
  config?: unknown;
  /** A sprint board's sprint (its name is for the scope line only). */
  sprint?: { id: string; name?: string } | null;
  rows: Record<string, unknown>[];
}): BoardQuery {
  const { orgId, projectId, config, sprint, rows } = opts;
  const cqlSchema = useCqlSchema(orgId);
  const enabled = cqlSchema.enabled;
  const url = useCqlUrlState();
  const validation = useCqlValidate(orgId, url.cql, enabled);

  const sprintId = sprint?.id ?? null;
  const sprintName = sprint?.name;
  const baseline = useMemo(
    () => boardBaseline(config, sprintId ? { id: sprintId, name: sprintName } : null),
    [config, sprintId, sprintName],
  );
  const user = useMemo(() => parseCql(url.cql), [url.cql]);
  const userOk = !user.diagnostics.some((d) => d.severity === "error");
  // The query sent to the server: baseline AND the user's (while it parses) AND
  // this board's project, so the id fallback never reaches beyond the board.
  const effective = useMemo<CqlQuery | null>(() => {
    const where = and(baseline.query?.where, userOk ? user.query.where : null);
    return where ? { v: CQL_VERSION, where: and(where, ref("project", "project", projectId)) } : null;
  }, [baseline.query, user.query, userOk, projectId]);
  const hash = effective ? hashQuery(effective) : "none";

  const predicate = useQuery({
    queryKey: useOrgQueryKey("board-predicate", projectId, hash),
    queryFn: () =>
      jsonFetch<{ where: unknown }>(`/api/v1/orgs/${orgId}/cql/predicate`, {
        method: "POST",
        body: JSON.stringify({ query: effective, tz: viewerTimeZone(), contextProjectId: projectId }),
      }),
    enabled: enabled && !!effective && !baseline.problem,
    staleTime: 60_000,
    retry: false,
  });

  const where = predicate.data?.where;
  const verdicts = useMemo(() => {
    if (!where) return null;
    return new Map(rows.map((r) => [r.id as string, matches(where, r)]));
  }, [where, rows]);
  const undecided = !!verdicts && [...verdicts.values()].some((v) => v === UNDECIDED);

  const ids = useQuery({
    queryKey: useOrgQueryKey("board-ids", projectId, hash),
    queryFn: () =>
      jsonFetch<{ ids: string[] }>(`/api/v1/orgs/${orgId}/work-items/query`, {
        method: "POST",
        body: JSON.stringify({ query: effective, idsOnly: true, tz: viewerTimeZone(), contextProjectId: projectId }),
      }),
    enabled: enabled && undecided,
    staleTime: 30_000,
    retry: false,
  });
  const idSet = useMemo(() => (ids.data ? new Set(ids.data.ids) : null), [ids.data]);

  // The rows on the board, decided once per change of rows, predicate or ids.
  const kept = useMemo((): Set<string> | "all" | "none" => {
    if (baseline.problem) return "none";
    if (!effective) return "all";
    // Until the predicate arrives, nothing: showing everything would flash the
    // unfiltered board, which is the widening this hook exists to prevent.
    if (!verdicts) return "none";
    const out = new Set<string>();
    for (const [id, v] of verdicts) if (v === true || (v === UNDECIDED && idSet?.has(id))) out.add(id);
    return out;
  }, [baseline.problem, effective, verdicts, idSet]);
  const keep = (row: { id: string }): boolean => {
    if (kept === "all") return true;
    if (kept === "none") return false;
    if (kept.has(row.id)) return true;
    // A row loaded after the predicate (a new card): judge it on arrival.
    if (where && !verdicts?.has(row.id)) {
      const now = matches(where, row as Record<string, unknown>);
      return now === true || (now === UNDECIDED && !!idSet?.has(row.id));
    }
    return false;
  };

  return {
    enabled,
    keep,
    pending: enabled && !!effective && (predicate.isLoading || (undecided && ids.isLoading)),
    baselineCql: baseline.query ? printCql(baseline.query) : null,
    problem: baseline.problem ?? null,
    schema: cqlSchema.schema,
    cql: url.cql,
    // One navigation (see useCqlUrlState.update): writing the text and then the
    // mode loses the text, both being built from one searchParams snapshot.
    setCql: (cql, mode) => url.update({ cql: cql.trim() || null, ...(mode ? { mode } : {}) }),
    mode: url.mode,
    setMode: url.setMode,
    diagnostics: validation.data?.diagnostics ?? [],
  };
}
