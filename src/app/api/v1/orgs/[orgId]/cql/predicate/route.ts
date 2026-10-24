import { NextRequest } from "next/server";
import { z } from "zod";
import { success } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { predicateCql } from "@/lib/query/execute.server";
import { cqlErrorResponse, cqlGate } from "@/lib/query/route.server";

type RouteParams = { params: Promise<{ orgId: string }> };

const scalar = z.union([z.string().max(200), z.number(), z.boolean()]);

const bodySchema = z.strictObject({
  cql: z.string().max(4000).optional(),
  query: z.unknown().optional(),
  tz: z.string().max(64).optional(),
  vars: z.record(z.string().regex(/^[A-Za-z_]\w{0,40}$/), z.union([scalar, z.null(), z.array(scalar).max(200)])).optional(),
  contextProjectId: z.string().uuid().optional(),
});

/**
 * POST: compile a query for the caller WITHOUT running it, and return its
 * full scoped where (the envelope included) for boards to evaluate over the
 * items they already loaded (query design §12.1, lib/query/evaluate.ts).
 *
 *   { cql: "assignee = me AND sprint IN openSprints()" }
 *   → { where, query, cql, diagnostics }
 *
 * The where names only what the caller can read: the resolver already scoped
 * every value. Invalid CQL is a 400 with positions, as for search.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const gate = await cqlGate(orgId);
    if ("response" in gate) return gate.response;

    const limited = checkRateLimit(request, "cql.predicate", gate.ctx.userId, { capacity: 60, refillPerSecond: 6 });
    if (limited) return limited;

    const body = bodySchema.parse(await request.json().catch(() => ({})));
    return success(
      await predicateCql(gate.ctx, { cql: body.cql, query: body.query }, { tz: body.tz, vars: body.vars, contextProjectId: body.contextProjectId }),
    );
  } catch (e) {
    return cqlErrorResponse(e);
  }
}
