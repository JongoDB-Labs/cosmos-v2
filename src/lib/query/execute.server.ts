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
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
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
import { compileQuery, type Compiled } from "./compile";
import type { CompileEnv } from "./env";
import { printCql } from "./print";
import { CqlError, diag, hasErrors, type CqlDiagnostic, type Span } from "./errors";
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
    contextProjectId: opts.contextProjectId ?? raw.context?.projectId,
    sinceLastStandup: opts.sinceLastStandup,
    mode: opts.mode === "warn" ? "warn" : "strict",
  });
  const diagnostics = [...checked.diagnostics, ...resolved.diagnostics];
  if (hasErrors(diagnostics)) throw new CqlError(diagnostics);

  return {
    orgId: ctx.orgId,
    readable,
    query: resolved.query,
    cql: printCql(resolved.query),
    env: resolved.env,
    compiled: compileQuery(resolved.query, resolved.env),
    diagnostics,
  };
}

const TIMEOUT_RE = /statement timeout|canceling statement|57014/i;

/** Run `fn` in a transaction whose statements are cancelled after `ms`. */
export async function withStatementTimeout<T>(ms: number, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        // set_config(..., true) is SET LOCAL: it ends with this transaction.
        // A bound parameter, so no SQL is ever built from a string.
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(Math.round(ms))}, true)`;
        return fn(tx);
      },
      { timeout: ms + 5_000, maxWait: 5_000 },
    );
  } catch (e) {
    if (TIMEOUT_RE.test(String((e as Error)?.message ?? ""))) {
      throw new CqlError(
        [diag("", "CQL_TIMEOUT", "This query took too long. Narrow it with a project, a sprint or a date range.")],
        422,
      );
    }
    throw e;
  }
}

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
      fetchIssueRows(tx, {
        where,
        orderBy: prepared.compiled.orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orgId: prepared.orgId,
        allowedProjectIds: prepared.readable,
      }),
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
    fetchIssueRows(tx, {
      where,
      orderBy: prepared.compiled.orderBy,
      skip: 0,
      take: EXPORT_MAX_ROWS,
      orgId: prepared.orgId,
      allowedProjectIds: prepared.readable,
    }),
  );
  return { data, query: prepared.query, cql: prepared.cql };
}
