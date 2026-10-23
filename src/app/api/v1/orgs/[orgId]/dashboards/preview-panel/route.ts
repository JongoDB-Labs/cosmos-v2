import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { success } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { cqlErrorResponse, cqlGate, cqlTooLong } from "@/lib/query/route.server";
import { parseCql } from "@/lib/query/parser";
import { hasErrors } from "@/lib/query/errors";
import { isValidTimeZone } from "@/lib/query/dates";
import { computePanels, drillPanel } from "@/lib/dashboards/panel-data.server";
import { sliceSchema } from "@/lib/dashboards/drill";
import { filterDefsSchema, filterValueSchema } from "@/lib/dashboards/filters";

type RouteParams = { params: Promise<{ orgId: string }> };

const bodySchema = z.strictObject({
  type: z.string().min(1).max(40),
  /** The panel's query as CQL text, or as a CqlQuery JSON; neither for a text panel. */
  cql: z.string().optional(),
  query: z.unknown().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  ignoreFilters: z.array(z.string().max(70)).max(8).default([]),
  filters: filterDefsSchema.default([]),
  filterValues: z.record(z.string().max(70), filterValueSchema).default({}),
  tz: z.string().max(64).default("UTC"),
  contextProjectId: z.string().uuid().optional(),
  /** Set to list the items behind one slice instead of the panel itself. */
  drill: sliceSchema.optional(),
});

/**
 * POST — compute one panel for the editor's preview (dashboards design §7.2).
 * Nothing is stored. The data is the caller's: computed as them, through the
 * same computePanels a saved dashboard will use. Behind the query-language
 * switch, like every surface built on it.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const gate = await cqlGate(orgId);
    if ("response" in gate) return gate.response;
    const limited = checkRateLimit(request, "dashboards.preview", gate.ctx.userId, { capacity: 30, refillPerSecond: 3 });
    if (limited) return limited;

    const body = bodySchema.parse(await request.json().catch(() => ({})));
    if (body.cql !== undefined && body.query !== undefined) {
      return NextResponse.json({ error: "Send the query as `cql` or `query`, not both." }, { status: 400 });
    }
    if (!isValidTimeZone(body.tz)) return NextResponse.json({ error: "Unknown time zone." }, { status: 400 });
    let query: unknown = body.query ?? null;
    if (body.cql !== undefined) {
      const long = cqlTooLong(body.cql);
      if (long) return long;
      const parsed = parseCql(body.cql);
      if (hasErrors(parsed.diagnostics)) {
        return NextResponse.json({ error: { code: "CQL_INVALID", message: "The query has errors.", diagnostics: parsed.diagnostics } }, { status: 400 });
      }
      query = parsed.query;
    }
    const spec = { type: body.type, query, config: body.config, ignoreFilters: body.ignoreFilters };
    const opts = {
      tz: body.tz,
      filters: body.filters,
      filterValues: body.filterValues,
      ...(body.contextProjectId ? { contextProjectId: body.contextProjectId } : {}),
    };
    if (body.drill) return success(await drillPanel(gate.ctx, spec, body.drill, opts));
    const [result] = await computePanels(gate.ctx, [spec], opts);
    return success(result);
  } catch (e) {
    return cqlErrorResponse(e);
  }
}
