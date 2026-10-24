import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { success, created } from "@/lib/api-helpers";
import { getPublicOrigin } from "@/lib/auth/public-url";
import { cqlErrorResponse, cqlGate } from "@/lib/query/route.server";
import { canSee, viewerScope } from "@/lib/query/saved-filters.server";
import { createFilterSubscription, listFilterSubscriptions } from "./route.contract";
import { createSubscription, listSubscriptions, loadView, subscriptionProblem } from "@/lib/query/subscriptions.server";

type RouteParams = { params: Promise<{ orgId: string; viewId: string }> };

const subscriptionBody = z.strictObject({
  recipient: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("me") }),
    z.strictObject({ kind: z.literal("team"), teamId: z.string().uuid() }),
  ]),
  cron: z.string().trim().min(9).max(100),
  timezone: z.string().min(1).max(64),
  format: z.enum(["LIST", "COUNT"]).optional(),
  sendWhenEmpty: z.boolean().optional(),
  onlyChanges: z.boolean().optional(),
});

/**
 * A saved filter's email subscriptions (query design §12.4).
 * GET   the ones the caller made, that reach them, or (admins) all of them;
 *       plus the caller's teams, for the dialog's recipient picker.
 * POST  subscribe yourself, or a team you're on and manage.
 * Behind the query-language switch, like every CQL surface.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, viewId } = await params;
    const gate = await cqlGate(orgId, listFilterSubscriptions);
    if ("response" in gate) return gate.response;
    const s = await viewerScope(gate.ctx);
    const view = await loadView(orgId, viewId);
    if (!view || !canSee(s, view)) return new Response("Not found", { status: 404 });
    // The teams the caller could subscribe: theirs (the server re-checks the rest).
    const teams = await prisma.team.findMany({ where: { id: { in: [...s.teams.keys()] } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    return success({ subscriptions: await listSubscriptions(s, viewId), teams });
  } catch (e) {
    return cqlErrorResponse(e);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, viewId } = await params;
    const gate = await cqlGate(orgId, createFilterSubscription);
    if ("response" in gate) return gate.response;
    const s = await viewerScope(gate.ctx);
    const view = await loadView(orgId, viewId);
    if (!view || !canSee(s, view)) return new Response("Not found", { status: 404 });
    const body = subscriptionBody.parse(await request.json().catch(() => ({})));
    const problem = await subscriptionProblem(s, view, body);
    if (problem) return NextResponse.json({ error: problem }, { status: problem === "Filter not found" ? 404 : 400 });
    return created({ subscription: await createSubscription(s, view, body, getPublicOrigin(request)) });
  } catch (e) {
    return cqlErrorResponse(e);
  }
}
