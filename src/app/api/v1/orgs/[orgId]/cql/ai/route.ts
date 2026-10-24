import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { success } from "@/lib/api-helpers";
import { checkRateLimit } from "@/lib/rate-limit/guard";
import { AI_PROMPT_MAX, AiUnavailableError, cqlFromText } from "@/lib/query/ai-filter.server";
import { cqlErrorResponse, cqlGate } from "@/lib/query/route.server";

type RouteParams = { params: Promise<{ orgId: string }> };

const bodySchema = z.strictObject({
  prompt: z.string().trim().min(1).max(AI_PROMPT_MAX),
  tz: z.string().max(64).optional(),
});

/**
 * POST — "Ask AI to build a filter": `{ prompt }` → `{ cql, diagnostics }`.
 * The editor puts the query in front of the user; nothing runs it here.
 * Rate limited harder than the other CQL routes: each call is a model turn.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const gate = await cqlGate(orgId);
    if ("response" in gate) return gate.response;

    const limited = checkRateLimit(request, "cql.ai", gate.ctx.userId, { capacity: 5, refillPerSecond: 0.2 });
    if (limited) return limited;

    const body = bodySchema.parse(await request.json().catch(() => ({})));
    try {
      return success(await cqlFromText(gate.ctx, body.prompt, { tz: body.tz }));
    } catch (e) {
      if (!(e instanceof AiUnavailableError)) throw e;
      // No model connected, the provider down, a controlled marking in the
      // sentence: the box says the assistant couldn't help, never a 500.
      const cause = e.cause instanceof Error ? e.cause.name : typeof e.cause;
      console.warn("[cql.ai] model turn failed", cause);
      return NextResponse.json(
        { error: { code: "AI_UNAVAILABLE", message: "The assistant couldn't build a query just now. Try again, or write it yourself." } },
        { status: 503 },
      );
    }
  } catch (e) {
    return cqlErrorResponse(e);
  }
}
