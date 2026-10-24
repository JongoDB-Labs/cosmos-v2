/**
 * The ONE way to run a CQL query: `executeCql(ctx, input, opts)`.
 *
 *   text ─parse─▶ AST ─typecheck─▶ ─resolve (scoped)─▶ ─compile (pure)─▶
 *     buildScopedWhere(org, readable, archived, user) ─▶ $transaction with a
 *     statement timeout ─▶ IssueRow[]
 *
 * It computes the readable project set ITSELF from the AuthContext; no caller
 * can hand it a project list. Every surface (Issues, boards, dashboards, saved
 * filters, subscriptions, the assistant, API keys) goes through here, and an
 * arch test asserts nothing else imports compile.ts.
 */
import { Prisma } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { buildScopedWhere } from "@/lib/work-items/query/build-where";
import { fetchIssueRows, type IssueRow } from "@/lib/work-items/query/project";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "@/lib/work-items/query/filter";
import type { CqlQuery } from "./ast";
import { parseCql } from "./parser";
import { limitDiagnostics, validateAst } from "./normalize";
import { typecheck } from "./typecheck";
import { loadSchemaCustomFields, resolveQuery, type VarInput } from "./resolve.server";
import { compileQuery, historySpecs, type Compiled } from "./compile";
import { runHistoryPrefilters } from "./history.server";
import { withStatementTimeout } from "./timeout.server";
import { inOrder, sortedIds } from "./sort.server";
import type { CompileEnv } from "./env";
import { printCql } from "./print";
import { CqlError, diag, hasErrors, tooBroad, type CqlDiagnostic, type Span } from "./errors";
import { isValidTimeZone } from "./dates";

export interface CqlInput {
  /** CQL text. Exactly one of `cql` / `query`. */
  cql?: string;
  /** A CqlQuery as JSON (a saved filter, a dashboard panel). */
  query?: unknown;
}

export interface CqlRunOptions {
  page?: number;
  pageSize?: number;
  /** IANA zone for startOfWeek() and date literals. Defaults to UTC. */
  tz?: string;
  now?: Date;
  vars?: Record<string, VarInput>;
  contextProjectId?: string;
  sinceLastStandup?: Date;
  /** Statement budget, ms. 3 s interactive; exports and subscriptions pass 10 s. */
  timeoutMs?: number;
  countTimeoutMs?: number;
  /** Rows, then the count, one transaction at a time (background work such as parity). */
  sequential?: boolean;
  /** Validation strictness for unknown values (validate route only). */
  mode?: "strict" | "warn" | "none";
}

export interface PreparedCql {
  orgId: string;
  readable: string[];
  /** The resolved query: refs with labels, functions symbolic. */
  query: CqlQuery;
  /** Canonical text, printed from the resolved query. */
  cql: string;
  env: CompileEnv;
  compiled: Compiled;
  /** Warnings and notes (errors throw). */
  diagnostics: CqlDiagnostic[];
}

export interface CqlResult {
  data: IssueRow[];
  /** null when counting exceeded its budget; see `totalCapped`. */
  total: number | null;
  totalCapped: boolean;
  query: CqlQuery;
  cql: string;
  diagnostics: CqlDiagnostic[];
}

/** Parse / validate the input into an unresolved query, or throw with diagnostics. */
export function parseInput(input: CqlInput): { query: CqlQuery; text: string; spans?: WeakMap<object, Span> } {
  const hasText = typeof input.cql === "string";
  const hasQuery = input.query !== undefined && input.query !== null;
  if (hasText === hasQuery) {
    throw new CqlError([diag("", "CQL_INVALID_AST", "Send exactly one of `cql` (text) or `query` (JSON).")]);
  }
  if (hasText) {
    const text = input.cql!;
    const parsed = parseCql(text);
    const all = [...parsed.diagnostics, ...limitDiagnostics(parsed.query, text)];
    if (hasErrors(all)) throw new CqlError(all);
    return { query: parsed.query, text, spans: parsed.spans };
  }
  const v = validateAst(input.query);
  if (!v.query) throw new CqlError(v.diagnostics);
  return { query: v.query, text: "" };
}

/**
 * Everything short of running: scope, typecheck, resolve, compile. The
 * aggregate endpoint and the parity check share it with executeCql.
 */
export async function prepareCql(ctx: AuthContext, input: CqlInput, opts: CqlRunOptions = {}): Promise<PreparedCql> {
  const { query: raw, text, spans } = parseInput(input);
  const readable = await getReadableProjectIds(ctx);
  const customFields = await loadSchemaCustomFields(ctx.orgId, readable);

  const checked = typecheck(raw, { customFields }, text, spans);
  if (hasErrors(checked.diagnostics)) throw new CqlError(checked.diagnostics);

  const tz = opts.tz && isValidTimeZone(opts.tz) ? opts.tz : "UTC";
  const resolved = await resolveQuery({
    ctx,
    readable,
    query: checked.query,
    customFields,
    text,
    spans,
    now: opts.now ?? new Date(),
    tz,
    vars: opts.vars,
    timeoutMs: opts.timeoutMs,
    contextProjectId: opts.contextProjectId ?? raw.context?.projectId,
    sinceLastStandup: opts.sinceLastStandup,
    mode: opts.mode === "warn" ? "warn" : "strict",
  });
  const diagnostics = [...checked.diagnostics, ...resolved.diagnostics];
  if (hasErrors(diagnostics)) throw new CqlError(diagnostics);

  // History clauses Prisma can't express become id sets first (history.server.ts).
  const specs = historySpecs(resolved.query.where, resolved.env);
  if (specs.length) {
    resolved.env.history = await withStatementTimeout(opts.timeoutMs ?? 3_000, (tx) =>
      runHistoryPrefilters(tx, specs, ctx.orgId, readable),
    );
  }

  const compiled = compileQuery(resolved.query, resolved.env);
  if (listValues(compiled.where) > MAX_LIST_VALUES) throw tooBroad("query");

  return {
    orgId: ctx.orgId,
    readable,
    query: resolved.query,
    cql: printCql(resolved.query),
    env: resolved.env,
    compiled,
    diagnostics,
  };
}

/**
 * Prisma binds every value of an `in` / `notIn` list as its own parameter and
 * Postgres takes about 32,766 per statement; past this the query is refused
 * with advice instead of failing in the driver.
 */
export const MAX_LIST_VALUES = 30_000;

/** How many `in` / `notIn` values a where carries. Iterative: no recursion depth to blow. */
export function listValues(where: unknown): number {
  let n = 0;
  const stack: unknown[] = [where];
  while (stack.length) {
    const v = stack.pop();
    if (Array.isArray(v)) stack.push(...v);
    else if (v && typeof v === "object" && !(v instanceof Date)) {
      for (const [k, x] of Object.entries(v)) {
        if ((k === "in" || k === "notIn") && Array.isArray(x)) n += x.length;
        else stack.push(x);
      }
    }
  }
  return n;
}

// Re-exported: callers and tests import it from here.
export { withStatementTimeout } from "./timeout.server";

export async function executeCql(ctx: AuthContext, input: CqlInput, opts: CqlRunOptions = {}): Promise<CqlResult> {
  const prepared = await prepareCql(ctx, input, opts);
  const page = Math.max(1, Math.trunc(opts.page ?? 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(opts.pageSize ?? DEFAULT_PAGE_SIZE)));

  if (prepared.readable.length === 0) {
    return { data: [], total: 0, totalCapped: false, query: prepared.query, cql: prepared.cql, diagnostics: prepared.diagnostics };
  }
  const where = buildScopedWhere({
    orgId: prepared.orgId,
    allowedProjectIds: prepared.readable,
    archived: prepared.compiled.archived,
    user: prepared.compiled.where,
  });

  const rows = () =>
    withStatementTimeout(opts.timeoutMs ?? 3_000, (tx) =>
      pageOfRows(tx, prepared, where, { skip: (page - 1) * pageSize, take: pageSize }),
    );
  // Counting has its own, smaller budget: a slow count must not cost the
  // rows, it just reads "1,000+".
  const count = () =>
    withStatementTimeout(opts.countTimeoutMs ?? 1_500, (tx) => tx.workItem.count({ where })).catch((e) => {
      if (e instanceof CqlError && e.diagnostics[0]?.code === "CQL_TIMEOUT") return null;
      throw e;
    });
  const [data, total] = opts.sequential ? [await rows(), await count()] : await Promise.all([rows(), count()]);

  return {
    data,
    total,
    totalCapped: total === null,
    query: prepared.query,
    cql: prepared.cql,
    diagnostics: prepared.diagnostics,
  };
}

/** The Issues CSV export's cap, the same as the legacy export's. */
export const EXPORT_MAX_ROWS = 50_000;

/**
 * Every row a query matches, up to EXPORT_MAX_ROWS, for the CSV export: the
 * same scope envelope and resolver as `executeCql`, no count, and the 10 s
 * budget exports get.
 */
export async function exportCql(ctx: AuthContext, input: CqlInput, opts: Omit<CqlRunOptions, "page" | "pageSize" | "countTimeoutMs"> = {}) {
  const prepared = await prepareCql(ctx, input, opts);
  if (prepared.readable.length === 0) return { data: [], query: prepared.query, cql: prepared.cql };
  const where = buildScopedWhere({
    orgId: prepared.orgId,
    allowedProjectIds: prepared.readable,
    archived: prepared.compiled.archived,
    user: prepared.compiled.where,
  });
  const data = await withStatementTimeout(opts.timeoutMs ?? 10_000, (tx) =>
    pageOfRows(tx, prepared, where, { skip: 0, take: EXPORT_MAX_ROWS }, EXPORT_MAX_ROWS),
  );
  return { data, query: prepared.query, cql: prepared.cql };
}

/** One page of rows: Prisma's ORDER BY, or the SQL sort then hydrate by id (sort.server.ts). */
async function pageOfRows(
  tx: Prisma.TransactionClient,
  prepared: PreparedCql,
  where: Prisma.WorkItemWhereInput,
  page: { skip: number; take: number },
  /** The SQL sort's cap: an export sorts as many items as it may return. */
  sortMax?: number,
): Promise<IssueRow[]> {
  const base = { orgId: prepared.orgId, allowedProjectIds: prepared.readable };
  if (!prepared.compiled.sqlSort) {
    return fetchIssueRows(tx, { ...base, where, orderBy: prepared.compiled.orderBy, ...page });
  }
  const ids = await sortedIds(tx, where, prepared.compiled.sqlSort, page, sortMax);
  if (ids.length === 0) return [];
  // Still inside the envelope: the ids came from it, and the hydrate re-checks.
  // In chunks: Prisma binds one parameter per id, and an export's 50k would
  // pass the driver's 32,766-parameter limit.
  const rows: IssueRow[] = [];
  for (let i = 0; i < ids.length; i += HYDRATE_CHUNK) {
    const chunk = ids.slice(i, i + HYDRATE_CHUNK);
    rows.push(...(await fetchIssueRows(tx, { ...base, where: { AND: [where, { id: { in: chunk } }] }, orderBy: [{ id: "desc" }], skip: 0, take: chunk.length })));
  }
  return inOrder(ids, rows);
}

const HYDRATE_CHUNK = 5_000;

/**
 * A query's full scoped where (envelope + predicate) in a form that survives
 * JSON, for the board's in-memory interpreter (evaluate.ts). Dates become ISO
 * strings; Prisma's JSON-null sentinels become `{ $null: … }` markers.
 */
export async function predicateCql(ctx: AuthContext, input: CqlInput, opts: CqlRunOptions = {}) {
  const prepared = await prepareCql(ctx, input, opts);
  const where = buildScopedWhere({
    orgId: prepared.orgId,
    allowedProjectIds: prepared.readable,
    archived: prepared.compiled.archived,
    user: prepared.compiled.where,
  });
  return { where: portableWhere(where), query: prepared.query, cql: prepared.cql, diagnostics: prepared.diagnostics };
}

export function portableWhere(where: unknown): unknown {
  const nulls = new Map<unknown, string>([
    [Prisma.AnyNull, "AnyNull"],
    [Prisma.DbNull, "DbNull"],
    [Prisma.JsonNull, "JsonNull"],
  ]);
  return JSON.parse(JSON.stringify(where, (_k, v) => (nulls.has(v) ? { $null: nulls.get(v) } : v)));
}

/** A board's fallback (query design §12.1): ids only, at most this many. */
export const IDS_ONLY_MAX = 5_000;

/**
 * Just the ids a query matches, for a board whose rows can't decide the
 * predicate themselves (comments, watchers, history…). Same scope and budget as
 * search; past IDS_ONLY_MAX it is refused, never truncated (a truncated id set
 * would hide cards silently).
 */
export async function idsCql(ctx: AuthContext, input: CqlInput, opts: CqlRunOptions = {}): Promise<{ ids: string[] }> {
  const prepared = await prepareCql(ctx, input, opts);
  if (prepared.readable.length === 0) return { ids: [] };
  const where = buildScopedWhere({
    orgId: prepared.orgId,
    allowedProjectIds: prepared.readable,
    archived: prepared.compiled.archived,
    user: prepared.compiled.where,
  });
  const rows = await withStatementTimeout(opts.timeoutMs ?? 3_000, (tx) =>
    tx.workItem.findMany({ where, select: { id: true }, take: IDS_ONLY_MAX + 1 }),
  );
  if (rows.length > IDS_ONLY_MAX) {
    throw new CqlError([diag("", "CQL_TOO_BROAD", `This query matches more than ${IDS_ONLY_MAX.toLocaleString("en-US")} items. Narrow it with a project or a sprint.`)], 422);
  }
  return { ids: rows.map((r) => r.id) };
}
