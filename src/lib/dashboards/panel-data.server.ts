/**
 * Compute panels for a viewer (dashboards design §7.1, §7.2). One entry point
 * for the editor's preview and, with D1, for stored dashboards' /data and
 * /drill routes, so a preview and the saved panel can never disagree.
 *
 * A batch never fails as a whole: each panel answers `{ data, meta }` or
 * `{ error }`, so one broken query leaves the rest of a standup on screen.
 */
import type { AuthContext } from "@/lib/rbac/check";
import { CqlError, type CqlDiagnostic } from "@/lib/query/errors";
import { validateAst } from "@/lib/query/normalize";
import type { CqlQuery } from "@/lib/query/ast";
import { isPanelType, parsePanelConfig, PANEL_TYPES } from "./panel-registry";
import { filterVars, withFilters, type DashboardFilterDef, type FilterValues } from "./filters";
import { COMPUTES } from "./panel-compute.server";
import { drillQuery, type Slice } from "./drill";
import { loadClassifier, type Classifier, type PanelMeta, type PanelRunContext } from "./panel-run.server";

export interface PanelSpec {
  id?: string;
  type: string;
  /** A CqlQuery JSON (validated here), or null. */
  query: unknown;
  config: unknown;
  ignoreFilters?: string[];
}

export type PanelResult =
  | { id?: string; data: unknown; meta: PanelMeta }
  | { id?: string; error: { code: string; message: string; diagnostics?: CqlDiagnostic[] } };

export interface RunOptions {
  tz: string;
  now?: Date;
  filters?: readonly DashboardFilterDef[];
  filterValues?: FilterValues;
  sinceLastStandup?: Date;
  contextProjectId?: string;
}

function fail(id: string | undefined, code: string, message: string, diagnostics?: CqlDiagnostic[]): PanelResult {
  return { ...(id ? { id } : {}), error: { code, message, ...(diagnostics ? { diagnostics } : {}) } };
}

async function one(spec: PanelSpec, ctx: PanelRunContext, cls: Classifier, opts: RunOptions): Promise<PanelResult> {
  const id = spec.id;
  if (!isPanelType(spec.type)) return fail(id, "PANEL_UNSUPPORTED", `This panel type ("${spec.type}") isn't supported.`);
  const parsed = parsePanelConfig(spec.type, spec.config);
  if (!parsed.ok) return fail(id, "PANEL_INVALID_CONFIG", parsed.error);

  let base: CqlQuery | null = null;
  if (spec.query != null) {
    const v = validateAst(spec.query);
    if (!v.query) return fail(id, "CQL_INVALID", "The panel's query isn't a valid query.", v.diagnostics);
    base = v.query;
  }
  const def = PANEL_TYPES[spec.type];
  const query = def.needsQuery ? withFilters(base, opts.filters ?? [], opts.filterValues ?? {}, spec.ignoreFilters ?? []) : { v: 1 as const, where: null };
  try {
    const compute = COMPUTES[spec.type] as (i: { query: CqlQuery; config: unknown }, c: PanelRunContext, k: Classifier) => ReturnType<(typeof COMPUTES)["item-list"]>;
    const out = await compute({ query, config: parsed.config }, ctx, cls);
    return { ...(id ? { id } : {}), data: out.data, meta: { ...out.meta, generatedAt: ctx.now.toISOString() } };
  } catch (e) {
    if (e instanceof CqlError) {
      const code = e.diagnostics[0]?.code ?? "CQL_INVALID";
      return fail(id, code, e.message, e.diagnostics);
    }
    throw e;
  }
}

/** Compute panels as `auth`. Panels run at most four at a time. */
export async function computePanels(auth: AuthContext, specs: readonly PanelSpec[], opts: RunOptions): Promise<PanelResult[]> {
  const now = opts.now ?? new Date();
  const ctx: PanelRunContext = {
    auth,
    tz: opts.tz,
    now,
    vars: filterVars(opts.filterValues ?? {}),
    ...(opts.sinceLastStandup ? { sinceLastStandup: opts.sinceLastStandup } : {}),
    ...(opts.contextProjectId ? { contextProjectId: opts.contextProjectId } : {}),
  };
  const cls = await loadClassifier(auth.orgId);
  const out: PanelResult[] = new Array(specs.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= specs.length) return;
      try {
        out[i] = await one(specs[i], ctx, cls, opts);
      } catch (e) {
        // One panel's failure never fails the batch; the cause is logged, not shown.
        console.error("[dashboards] panel failed", specs[i].type, e instanceof Error ? e.message : e);
        out[i] = fail(specs[i].id, "PANEL_FAILED", "This panel couldn't load. Try again.");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, specs.length) }, worker));
  return out;
}

/**
 * The items behind one slice of a panel (design §5.2 drill-down), as the
 * viewer: the panel's query with its filters, the slice's clauses, and the
 * item-list compute for the rows. Answers like a panel; `cql` in its meta is
 * the query to open in Issues.
 */
export async function drillPanel(auth: AuthContext, spec: PanelSpec, slice: Slice, opts: RunOptions & { limit?: number }): Promise<PanelResult> {
  const id = spec.id;
  if (!isPanelType(spec.type)) return fail(id, "PANEL_UNSUPPORTED", `This panel type ("${spec.type}") isn't supported.`);
  if (!PANEL_TYPES[spec.type].supportsDrill) return fail(id, "PANEL_NO_DRILL", "This panel doesn't drill down.");
  const parsed = parsePanelConfig(spec.type, spec.config);
  if (!parsed.ok) return fail(id, "PANEL_INVALID_CONFIG", parsed.error);
  let base: CqlQuery | null = null;
  if (spec.query != null) {
    const v = validateAst(spec.query);
    if (!v.query) return fail(id, "CQL_INVALID", "The panel's query isn't a valid query.", v.diagnostics);
    base = v.query;
  }
  const query = drillQuery(spec.type, parsed.config, withFilters(base, opts.filters ?? [], opts.filterValues ?? {}, spec.ignoreFilters ?? []), slice, opts.tz);
  if (!query) return fail(id, "PANEL_NO_DRILL", "That part of the panel has no items to list.");
  const [rows] = await computePanels(auth, [{ ...(id ? { id } : {}), type: "item-list", query, config: { limit: opts.limit ?? 50 } }], { ...opts, filters: [], filterValues: opts.filterValues });
  return rows;
}
