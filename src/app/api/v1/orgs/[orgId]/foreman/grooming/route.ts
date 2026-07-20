import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

/**
 * Read-only observability feed for the Foreman supervisor: the recent "groomed"
 * events for an org (what the supervisor did, or — in dry mode — would do). Same
 * ORG_UPDATE steering gate as the rest of the console's read surface. Each row
 * carries the action, one-line evidence, whether it was a dry proposal, and the
 * ticket it concerns, so the console can render both a feed and a per-ticket badge
 * from one call.
 */
type RouteParams = { params: Promise<{ orgId: string }> };

interface GroomingRow {
  id: string;
  ts: string;
  ticketKey: string | null;
  workItemId: string | null;
  action: string;
  evidence: string;
  dupOf: string | null;
  dry: boolean;
  prClosed: boolean | null;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, slug: true },
    });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_UPDATE);

    const sp = new URL(request.url).searchParams;
    const limit = Math.min(Number(sp.get("limit") ?? "50") || 50, 200);
    // Optional: scope to one work item (the per-ticket badge on the card detail).
    const workItemId = sp.get("workItemId") ?? undefined;
    const events = await prisma.foremanEvent.findMany({
      where: { orgId, kind: "groomed", ...(workItemId ? { workItemId } : {}) },
      orderBy: [{ ts: "desc" }, { id: "desc" }],
      take: limit,
      select: { id: true, ts: true, ticketKey: true, workItemId: true, data: true },
    });
    const rows: GroomingRow[] = events.map((e) => {
      const d = (e.data ?? {}) as {
        action?: unknown;
        evidence?: unknown;
        dupOf?: unknown;
        dry?: unknown;
        prClosed?: unknown;
      };
      return {
        id: e.id,
        ts: e.ts.toISOString(),
        ticketKey: e.ticketKey,
        workItemId: e.workItemId,
        action: typeof d.action === "string" ? d.action : "unknown",
        evidence: typeof d.evidence === "string" ? d.evidence : "",
        dupOf: typeof d.dupOf === "string" ? d.dupOf : null,
        dry: d.dry === true,
        prClosed: typeof d.prClosed === "boolean" ? d.prClosed : null,
      };
    });
    return success({ rows });
  } catch (error) {
    return handleApiError(error);
  }
}
