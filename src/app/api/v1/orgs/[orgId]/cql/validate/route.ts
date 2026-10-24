import { NextRequest } from "next/server";
import { z } from "zod";
import { success } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { parseInput, prepareCql } from "@/lib/query/execute.server";
import { loadSchemaCustomFields } from "@/lib/query/resolve.server";
import { typecheck } from "@/lib/query/typecheck";
import { printCql } from "@/lib/query/print";
import { CqlError } from "@/lib/query/errors";
import { cqlErrorResponse, cqlGate } from "@/lib/query/route.server";

type RouteParams = { params: Promise<{ orgId: string }> };

const bodySchema = z.strictObject({
  cql: z.string().max(4000).optional(),
  query: z.unknown().optional(),
  /** Jira's /jql/parse modes: strict = unknown values are errors, warn = warnings, none = syntax and types only. */
  mode: z.enum(["strict", "warn", "none"]).default("warn"),
  tz: z.string().max(64).optional(),
  contextProjectId: z.string().uuid().optional(),
});

/**
 * POST — check a query without running it. Always 200:
 *   { valid, query?, cql?, diagnostics }
 * The editor calls this (debounced) to underline unknown names; the assistant
 * calls it to fix its own queries.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const gate = await cqlGate(orgId);
    if ("response" in gate) return gate.response;

    const limited = checkRateLimit(request, "cql.validate", gate.ctx.userId, { capacity: 120, refillPerSecond: 12 });
    if (limited) return limited;

    const body = bodySchema.parse(await request.json().catch(() => ({})));
    const input = { cql: body.cql, query: body.query };
    try {
      if (body.mode === "none") {
        const { query, text, spans } = parseInput(input);
        const readable = await getReadableProjectIds(gate.ctx);
        const checked = typecheck(query, { customFields: await loadSchemaCustomFields(orgId, readable) }, text, spans);
        const valid = !checked.diagnostics.some((d) => d.severity === "error");
        return success({ valid, ...(valid ? { query: checked.query, cql: printCql(checked.query) } : {}), diagnostics: checked.diagnostics });
      }
      const prepared = await prepareCql(gate.ctx, input, { mode: body.mode, tz: body.tz, contextProjectId: body.contextProjectId });
      const valid = !prepared.diagnostics.some((d) => d.severity === "error");
      return success({ valid, query: prepared.query, cql: prepared.cql, diagnostics: prepared.diagnostics });
    } catch (e) {
      if (e instanceof CqlError) return success({ valid: false, diagnostics: e.diagnostics });
      throw e;
    }
  } catch (e) {
    return cqlErrorResponse(e);
  }
}
