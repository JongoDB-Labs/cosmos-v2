import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string }> };

interface QueueItem {
  ticketKey: string;
  title: string;
  classification: string;
  severity: string;
  /** Acceptance criteria (from AI triage) to hand the coding agent as its brief. */
  acceptanceCriteria: string[];
}

/**
 * Auto-fix queue for the PR-drafting bridge (FR 695aa097 follow-on). Returns the
 * org's DELIVERED feedback whose backlog ticket has NOT yet reached progress —
 * i.e. items triaged into the backlog but not yet being worked. The scheduled
 * `feedback-remediation-pr` workflow reads this to decide which tickets to draft
 * a fix for (it further skips any ticket that already has an `auto-fix/*` branch).
 *
 * Read-only. Auth via `resolveAuth` (org API key `Bearer cosmos_…` scope `read`
 * or a session), gated on ITEM_READ. `?limit=` caps the batch (default 5, max 20).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await resolveAuth(request, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    if (!hasPermission(ctx.permissions, Permission.ITEM_READ)) {
      return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 5, 1), 20);

    // Delivered (has a ticket) but still PLANNED — triaged into the backlog, not
    // yet picked up. Highest-voted first, mirroring the delivery order.
    const rows = await prisma.feedbackItem.findMany({
      where: { orgId, status: "PLANNED", workItemId: { not: null } },
      orderBy: [{ voteCount: "desc" }, { deliveredAt: "asc" }],
      take: limit,
      select: { title: true, triage: true, workItemId: true },
    });

    // FeedbackItem has no workItem relation, and WorkItem carries only projectId
    // (no project relation) — resolve tickets and their project keys in two batches.
    const workItemIds = rows.map((r) => r.workItemId).filter((x): x is string => !!x);
    const workItems = await prisma.workItem.findMany({
      where: { id: { in: workItemIds }, orgId },
      select: { id: true, ticketNumber: true, projectId: true },
    });
    const byId = new Map(workItems.map((w) => [w.id, w]));
    const projects = await prisma.project.findMany({
      where: { id: { in: workItems.map((w) => w.projectId) }, orgId },
      select: { id: true, key: true },
    });
    const keyByProject = new Map(projects.map((p) => [p.id, p.key]));

    const items: QueueItem[] = [];
    for (const r of rows) {
      const w = r.workItemId ? byId.get(r.workItemId) : undefined;
      const projectKey = w ? keyByProject.get(w.projectId) : undefined;
      if (!projectKey || !w || w.ticketNumber == null) continue;
      const t = (r.triage ?? {}) as Record<string, unknown>;
      const ac = Array.isArray(t.acceptanceCriteria)
        ? (t.acceptanceCriteria as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      items.push({
        ticketKey: `${projectKey}-${w.ticketNumber}`,
        title: r.title,
        classification: typeof t.classification === "string" ? t.classification : "FEATURE",
        severity: typeof t.severity === "string" ? t.severity : "medium",
        acceptanceCriteria: ac,
      });
    }

    return success({ items });
  } catch (error) {
    return handleApiError(error);
  }
}
