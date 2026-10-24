import { NextRequest } from "next/server";
import { z } from "zod";
import { success } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { suggestValues } from "@/lib/query/suggest.server";
import { cqlErrorResponse, cqlGate } from "@/lib/query/route.server";

type RouteParams = { params: Promise<{ orgId: string }> };

const querySchema = z.object({
  field: z.string().min(1).max(100),
  prefix: z.string().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

/**
 * GET ?field=assignee&prefix=da — value suggestions for the CQL editor and the
 * filter chips, scoped like the resolver: only what the caller could name in a
 * query. `{ items: [{ label, insert, detail?, kind }] }`.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const gate = await cqlGate(orgId);
    if ("response" in gate) return gate.response;

    const limited = checkRateLimit(request, "cql.suggest", gate.ctx.userId, { capacity: 120, refillPerSecond: 12 });
    if (limited) return limited;

    const q = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    return success({ items: await suggestValues(gate.ctx, q) });
  } catch (e) {
    return cqlErrorResponse(e);
  }
}
