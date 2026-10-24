import { NextRequest } from "next/server";
import { z } from "zod";
import { success } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { aggregateCql } from "@/lib/query/aggregate.server";
import { aggDimSchema, aggMeasureSchema, type AggDim, type AggMeasure } from "@/lib/query/aggregate";
import { cqlErrorResponse, cqlGate } from "@/lib/query/route.server";
import { savedFilterQuery } from "@/lib/query/saved-filters.server";

type RouteParams = { params: Promise<{ orgId: string }> };

const scalar = z.union([z.string().max(200), z.number(), z.boolean()]);

const bodySchema = z.strictObject({
  /** What to count: CQL text or a JSON query, or a saved filter by id. */
  source: z.union([
    z.strictObject({ kind: z.literal("cql"), cql: z.string().max(4000).optional(), query: z.unknown().optional() }),
    z.strictObject({ kind: z.literal("savedFilter"), id: z.string().uuid() }),
  ]),
  dims: z.array(aggDimSchema).max(2).default([]),
  measure: aggMeasureSchema.default({ fn: "count" }),
  tz: z.string().max(64).optional(),
  /** Dashboard variables; null (or absent) = unset, which leaves its conditions inert. */
  vars: z.record(z.string().regex(/^[A-Za-z_]\w{0,40}$/), z.union([scalar, z.null(), z.array(scalar).max(200)])).optional(),
  contextProjectId: z.string().uuid().optional(),
});

/**
 * POST: group and measure what a query matches, for dashboards (query design
 * §5, §12.2). Scoped exactly like search: a chart never counts an item its
 * viewer couldn't list.
 *
 *   { source: { kind: "cql", cql: "sprint IN openSprints()" },
 *     dims: [{ field: { kind: "sys", id: "assignee" } }, { field: { kind: "sys", id: "statusCategory" } }],
 *     measure: { fn: "sum", field: { kind: "sys", id: "points" } } }
 *   → { rows: [{ keys: [{ id, label }, …], value, count }], total, truncated, query, cql }
 *
 * A key's `id` is null for the empty group ("Unassigned") and "__other__" for
 * groups folded into "Other" (at most 25 per dimension, or `limit`). Date
 * dimensions take a bucket (day / week / month, in `tz`) and come back in time
 * order with empty buckets as zero.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const gate = await cqlGate(orgId);
    if ("response" in gate) return gate.response;

    const limited = checkRateLimit(request, "cql.aggregate", gate.ctx.userId, { capacity: 30, refillPerSecond: 3 });
    if (limited) return limited;

    const body = bodySchema.parse(await request.json().catch(() => ({})));
    let input: { cql?: string; query?: unknown };
    if (body.source.kind === "savedFilter") {
      const stored = await savedFilterQuery(gate.ctx, body.source.id);
      if (!stored) {
        return new Response(JSON.stringify({ error: "Saved filter not found" }), { status: 404, headers: { "content-type": "application/json" } });
      }
      input = { query: stored };
    } else {
      input = { cql: body.source.cql, query: body.source.query };
    }
    const result = await aggregateCql(
      gate.ctx,
      input,
      { dims: body.dims as AggDim[], measure: body.measure as AggMeasure },
      { tz: body.tz, vars: body.vars, contextProjectId: body.contextProjectId },
    );
    return success(result);
  } catch (e) {
    return cqlErrorResponse(e);
  }
}
