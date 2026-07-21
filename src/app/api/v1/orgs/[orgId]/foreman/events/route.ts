import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { readAutomationConfig } from "@/lib/feedback/automation-config";
import { EVENT_KINDS } from "@/lib/foreman/observe";

type RouteParams = { params: Promise<{ orgId: string }> };

/** Cursor-paged Foreman decision feed. Org rows always; org-less daemon rows
 *  (boot/breaker/error) included when this org has delivery enabled. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { slug: true, settings: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_UPDATE);

    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    const kind = url.searchParams.get("kind");
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));

    const enabled = readAutomationConfig(org.settings).autonomousDelivery.enabled;

    const events = await prisma.foremanEvent.findMany({
      where: {
        OR: enabled ? [{ orgId }, { orgId: null }] : [{ orgId }],
        ...(kind && (EVENT_KINDS as readonly string[]).includes(kind) ? { kind } : {}),
        // Internal loop-graph diagnostics (loop_*) feed the convergence dashboard,
        // not the human operator stream — keep them out of the default feed.
        NOT: { kind: { startsWith: "loop_" } },
      },
      orderBy: [{ ts: "desc" }, { id: "desc" }],
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    return success({
      events,
      nextCursor: events.length === limit ? events[events.length - 1]!.id : null,
    });
  } catch (e) {
    return handleApiError(e);
  }
}
