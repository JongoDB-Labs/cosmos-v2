import { NextRequest } from "next/server";
import { z } from "zod";
import { success } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { executeCql, idsCql } from "@/lib/query/execute.server";
import { cqlErrorResponse, cqlGate } from "@/lib/query/route.server";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/lib/work-items/query/filter";

type RouteParams = { params: Promise<{ orgId: string }> };

const scalar = z.union([z.string().max(200), z.number(), z.boolean()]);

const bodySchema = z.strictObject({
  cql: z.string().max(4000).optional(),
  query: z.unknown().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  tz: z.string().max(64).optional(),
  /** Dashboard variables; null (or absent) = unset, which leaves its conditions inert. */
  vars: z.record(z.string().regex(/^[A-Za-z_]\w{0,40}$/), z.union([scalar, z.null(), z.array(scalar).max(200)])).optional(),
  contextProjectId: z.string().uuid().optional(),
  /** Just the matching ids (at most 5,000), for a board that can't evaluate the query itself. */
  idsOnly: z.boolean().optional(),
});

/**
 * POST — run a CQL query (text or JSON AST) across every project the caller can
 * read. Works for sessions and API keys alike; an API key's project scope is
 * honoured because executeCql scopes through getReadableProjectIds.
 *
 *   { cql: "assignee = me AND statusCategory != done ORDER BY due", tz: "America/Chicago" }
 *   → { data: IssueRow[], total, totalCapped, query, cql, diagnostics }
 *
 * `idsOnly: true` → { ids } (at most 5,000; more is a 422 CQL_TOO_BROAD), for a
 * board whose rows can't decide the query themselves (lib/query/evaluate.ts).
 *
 * Invalid CQL → 400 { error: { code: "CQL_INVALID", diagnostics } } with exact
 * positions; a query over budget → 422 CQL_TIMEOUT.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const gate = await cqlGate(orgId);
    if ("response" in gate) return gate.response;

    const limited = checkRateLimit(request, "cql.query", gate.ctx.userId, { capacity: 30, refillPerSecond: 3 });
    if (limited) return limited;

    const body = bodySchema.parse(await request.json().catch(() => ({})));
    if (body.idsOnly) {
      return success(
        await idsCql(gate.ctx, { cql: body.cql, query: body.query }, { tz: body.tz, vars: body.vars, contextProjectId: body.contextProjectId }),
      );
    }
    const result = await executeCql(
      gate.ctx,
      { cql: body.cql, query: body.query },
      {
        page: body.page,
        pageSize: body.pageSize,
        tz: body.tz,
        vars: body.vars,
        contextProjectId: body.contextProjectId,
      },
    );
    return success(result);
  } catch (e) {
    return cqlErrorResponse(e);
  }
}
