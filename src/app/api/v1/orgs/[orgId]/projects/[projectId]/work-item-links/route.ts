import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission, ConflictError } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import {
  directedDependencyEdge,
  wouldCreateDependencyCycle,
  type DirectedEdge,
} from "@/lib/work-items/dependency-graph";
import { z } from "zod";
import { LinkType } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/**
 * Work-item dependency links (prod-parity feature). A link is a directed edge
 * between two work items in the SAME project, typed by `LinkType` (BLOCKS /
 * PREDECESSOR / RELATES / …). Used by the timeline (Gantt dependency arrows) and
 * the work-item detail panel. The 42 prod links (all PREDECESSOR) migrate into
 * this table and render here.
 *
 * Both endpoints scope strictly by orgId + projectId (every link's source AND
 * target must be a work item in this project) — no cross-tenant / cross-project
 * edge can be created or listed.
 */

/**
 * GET — links in this project (with ticket numbers + titles).
 *
 * Optional `?item={workItemId}` narrows to links that touch a single item
 * (as either source OR target) — used by the work-item detail panel so it only
 * loads its own edges instead of the whole project's link graph.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_READ);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    // Scope to links whose SOURCE item lives in this project (every link's both
    // ends share a project by construction, so this also scopes the target).
    // The unique (orgId, sourceItemId) index backs this lookup.
    const item = request.nextUrl.searchParams.get("item");
    const links = await prisma.workItemLink.findMany({
      where: {
        orgId,
        sourceItem: { projectId },
        ...(item ? { OR: [{ sourceItemId: item }, { targetItemId: item }] } : {}),
      },
      select: {
        id: true,
        type: true,
        sourceItemId: true,
        targetItemId: true,
        createdAt: true,
        sourceItem: { select: { ticketNumber: true, title: true } },
        targetItem: { select: { ticketNumber: true, title: true, projectId: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    return success(
      links.map((l) => ({
        id: l.id,
        type: l.type,
        sourceItemId: l.sourceItemId,
        targetItemId: l.targetItemId,
        sourceTicketNumber: l.sourceItem.ticketNumber,
        sourceTitle: l.sourceItem.title,
        targetTicketNumber: l.targetItem.ticketNumber,
        targetTitle: l.targetItem.title,
        createdAt: l.createdAt,
      })),
    );
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z.object({
  sourceItemId: z.string().uuid(),
  targetItemId: z.string().uuid(),
  type: z.nativeEnum(LinkType),
});

/** POST — create a directed link between two work items in this project. */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_UPDATE);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return new Response("Bad request", { status: 400 });
    const { sourceItemId, targetItemId, type } = parsed.data;
    if (sourceItemId === targetItemId) {
      return new Response("A work item cannot link to itself", { status: 400 });
    }

    // BOTH ends must be work items in THIS org+project (no cross-project edges).
    const ends = await prisma.workItem.findMany({
      where: { id: { in: [sourceItemId, targetItemId] }, orgId, projectId },
      select: { id: true },
    });
    if (ends.length !== 2) return new Response("Both items must be in this project", { status: 400 });

    // Load this project's existing links once and reject invalid states before
    // creating: an exact duplicate of an existing link, or a directed link that
    // would introduce a CIRCULAR dependency (A must precede B AND B must precede
    // A). Only directed types can form a cycle — RELATES/DUPLICATES/CLONES are
    // undirected — so undirected links skip the reachability check. Both throw a
    // ConflictError → 409 with a human message the detail panel surfaces.
    const existingLinks = await prisma.workItemLink.findMany({
      where: { orgId, sourceItem: { projectId } },
      select: { type: true, sourceItemId: true, targetItemId: true },
    });

    if (
      existingLinks.some(
        (l) => l.sourceItemId === sourceItemId && l.targetItemId === targetItemId && l.type === type,
      )
    ) {
      throw new ConflictError("These items are already linked with that relationship.");
    }

    const candidate = directedDependencyEdge(type, sourceItemId, targetItemId);
    if (candidate) {
      const edges = existingLinks
        .map((l) => directedDependencyEdge(l.type, l.sourceItemId, l.targetItemId))
        .filter((e): e is DirectedEdge => e !== null);
      if (wouldCreateDependencyCycle(edges, candidate)) {
        throw new ConflictError(
          "This link would create a circular dependency — the two items would each depend on the other.",
        );
      }
    }

    const link = await prisma.workItemLink.create({
      data: { orgId, sourceItemId, targetItemId, type },
      select: { id: true, type: true, sourceItemId: true, targetItemId: true, createdAt: true },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_item_link.create",
      entity: "work_item_link",
      entityId: link.id,
      metadata: { sourceItemId, targetItemId, type },
      ipAddress: getIpAddress(request),
    });
    publishToOrg(orgId, "work-item-link.created", { projectId, link });

    return created(link);
  } catch (error) {
    return handleApiError(error);
  }
}
