import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { resolveAuth } from "@/lib/auth/api-key";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; docId: string }>;
};

/** GET — the document's block→item links, with the linked item resolved (title,
 *  plus ticket for work items) so the Files view can show "linked" badges across
 *  every convert kind: work item, milestone, objective, goal, sprint, roadmap node. */
export async function GET(req: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, docId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await resolveAuth(req, org);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    const links = await prisma.documentItemLink.findMany({
      where: { orgId, projectId, block: { documentId: docId } },
      select: { id: true, blockId: true, itemType: true, itemId: true },
    });

    const idsFor = (type: string) =>
      links.filter((l) => l.itemType === type).map((l) => l.itemId);
    const where = (ids: string[]) => ({ id: { in: ids }, orgId, projectId });

    const [workItems, milestones, objectives, goals, intervals, roadmapNodes] = await Promise.all([
      idsFor("WORK_ITEM").length
        ? prisma.workItem.findMany({ where: where(idsFor("WORK_ITEM")), select: { id: true, title: true, ticketNumber: true } })
        : Promise.resolve([]),
      idsFor("MILESTONE").length
        ? prisma.milestone.findMany({ where: where(idsFor("MILESTONE")), select: { id: true, title: true } })
        : Promise.resolve([]),
      idsFor("OBJECTIVE").length
        ? prisma.objective.findMany({ where: where(idsFor("OBJECTIVE")), select: { id: true, title: true } })
        : Promise.resolve([]),
      idsFor("GOAL").length
        ? prisma.goal.findMany({ where: where(idsFor("GOAL")), select: { id: true, title: true } })
        : Promise.resolve([]),
      idsFor("INTERVAL").length
        ? prisma.interval.findMany({ where: where(idsFor("INTERVAL")), select: { id: true, name: true } })
        : Promise.resolve([]),
      idsFor("ROADMAP_NODE").length
        ? prisma.roadmapNode.findMany({ where: where(idsFor("ROADMAP_NODE")), select: { id: true, title: true } })
        : Promise.resolve([]),
    ]);

    const byId = new Map<string, { id: string; title: string; ticketNumber?: number }>([
      ...workItems.map((i) => [i.id, i] as const),
      ...milestones.map((i) => [i.id, i] as const),
      ...objectives.map((i) => [i.id, i] as const),
      ...goals.map((i) => [i.id, i] as const),
      // Intervals expose `name`, not `title` — normalize so the UI reads one shape.
      ...intervals.map((c) => [c.id, { id: c.id, title: c.name }] as const),
      ...roadmapNodes.map((i) => [i.id, i] as const),
    ]);

    return success(
      links.map((l) => ({ ...l, item: byId.get(l.itemId) ?? null })),
    );
  } catch (e) {
    return handleApiError(e);
  }
}
