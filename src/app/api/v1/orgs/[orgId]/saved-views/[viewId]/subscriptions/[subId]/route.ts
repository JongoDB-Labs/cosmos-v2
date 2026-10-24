import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { success, noContent } from "@/lib/api-helpers";
import { getPublicOrigin } from "@/lib/auth/public-url";
import type { RouteContract } from "@/lib/openapi/contract";
import { cqlErrorResponse, cqlGate } from "@/lib/query/route.server";
import { canSee, viewerScope } from "@/lib/query/saved-filters.server";
import { checkSchedule } from "@/lib/query/schedule";
import { deleteFilterSubscription, updateFilterSubscription } from "./route.contract";
import { canManageSubscription, deleteSubscription, loadView, updateSubscription } from "@/lib/query/subscriptions.server";

type RouteParams = { params: Promise<{ orgId: string; viewId: string; subId: string }> };

const patchBody = z.strictObject({
  cron: z.string().trim().min(9).max(100).optional(),
  timezone: z.string().min(1).max(64).optional(),
  format: z.enum(["LIST", "COUNT"]).optional(),
  sendWhenEmpty: z.boolean().optional(),
  onlyChanges: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

/** The subscription, when the caller may manage it; otherwise it reads as absent. */
async function load(orgId: string, viewId: string, subId: string, contract: Pick<RouteContract, "scopes">) {
  const gate = await cqlGate(orgId, contract);
  if ("response" in gate) return gate;
  const s = await viewerScope(gate.ctx);
  const view = await loadView(orgId, viewId);
  const sub = /^[0-9a-f-]{36}$/i.test(subId)
    ? await prisma.filterSubscription.findFirst({
        where: { id: subId, orgId, savedViewId: viewId },
        select: { id: true, savedViewId: true, createdById: true, recipientUserId: true, cron: true, timezone: true },
      })
    : null;
  if (!view || !sub || !canSee(s, view) || !canManageSubscription(s, sub)) {
    return { response: new Response("Not found", { status: 404 }) };
  }
  return { s, sub };
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, viewId, subId } = await params;
    const r = await load(orgId, viewId, subId, updateFilterSubscription);
    if ("response" in r) return r.response;
    const body = patchBody.parse(await request.json().catch(() => ({})));
    const sched = checkSchedule(body.cron ?? r.sub.cron, body.timezone ?? r.sub.timezone);
    if ("error" in sched) return NextResponse.json({ error: sched.error }, { status: 400 });
    return success({ subscription: await updateSubscription(r.s, r.sub, body, getPublicOrigin(request)) });
  } catch (e) {
    return cqlErrorResponse(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, viewId, subId } = await params;
    const r = await load(orgId, viewId, subId, deleteFilterSubscription);
    if ("response" in r) return r.response;
    await deleteSubscription(r.s, r.sub);
    return noContent();
  } catch (e) {
    return cqlErrorResponse(e);
  }
}
