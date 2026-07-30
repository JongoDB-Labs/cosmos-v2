import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { success, created, handleApiError } from "@/lib/api-helpers";

/**
 * Work items linked to an Objective — the high-level delivery it is tracked
 * against, so PI Objective progress can be read off real Feature delivery.
 *
 * Deliberately mirrors the Key Result links route: same auth shape, same
 * project-scoping, same idempotent upsert. Objective→OBJECTIVE laddering is NOT
 * here — `Objective.parentId` already does that and is edited on the OKR board.
 */
type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; objectiveId: string }>;
};

const bodySchema = z.object({ workItemId: z.string().uuid() });

/** Resolve + scope-check the objective (must be in this org + project). */
async function loadObjective(orgId: string, projectId: string, objectiveId: string) {
  return prisma.objective.findFirst({
    where: { id: objectiveId, orgId, projectId },
    select: { id: true },
  });
}

/** GET — the work items linked to this Objective. */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, objectiveId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "OKR_READ", { projectId });

    if (!(await loadObjective(orgId, projectId, objectiveId)))
      return new Response("Not found", { status: 404 });

    const links = await prisma.objectiveLink.findMany({
      where: { objectiveId },
      select: {
        id: true,
        workItem: {
          select: {
            id: true,
            ticketNumber: true,
            title: true,
            columnKey: true,
            completedAt: true,
            // The picker orders by the project's configured type, so the caller
            // needs each item's type id. Never a constructed type KEY.
            workItemTypeId: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    return success(links.map((l) => ({ linkId: l.id, ...l.workItem })));
  } catch (e) {
    return handleApiError(e);
  }
}

/** POST — link a work item to this Objective (idempotent). */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, objectiveId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "OKR_UPDATE", { projectId });

    if (!(await loadObjective(orgId, projectId, objectiveId)))
      return new Response("Not found", { status: 404 });

    const { workItemId } = bodySchema.parse(await request.json());
    // The work item must belong to this project (no cross-project links).
    const item = await prisma.workItem.findFirst({
      where: { id: workItemId, orgId, projectId },
      select: { id: true },
    });
    if (!item)
      return new Response(JSON.stringify({ error: "Work item not in this project" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });

    const link = await prisma.objectiveLink.upsert({
      where: { objectiveId_workItemId: { objectiveId, workItemId } },
      create: { orgId, objectiveId, workItemId },
      update: {},
      select: { id: true },
    });
    return created({ linkId: link.id });
  } catch (e) {
    return handleApiError(e);
  }
}

/** DELETE — unlink a work item from this Objective. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, objectiveId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "OKR_UPDATE", { projectId });

    if (!(await loadObjective(orgId, projectId, objectiveId)))
      return new Response("Not found", { status: 404 });

    const { workItemId } = bodySchema.parse(await request.json());
    await prisma.objectiveLink.deleteMany({ where: { objectiveId, workItemId } });
    return success({ ok: true });
  } catch (e) {
    return handleApiError(e);
  }
}
