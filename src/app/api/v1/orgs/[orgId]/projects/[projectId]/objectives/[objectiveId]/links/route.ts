import { NextRequest } from "next/server";
import { z } from "zod";
import { ObjectiveLinkKind } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { success, created, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; objectiveId: string }>;
};

// COSMOS-82: link a work item (a deliverable) OR another objective (a
// dependency) to this objective. `targetId` is the work item / objective id,
// interpreted per `kind`.
const bodySchema = z.object({
  kind: z.nativeEnum(ObjectiveLinkKind),
  targetId: z.string().uuid(),
});

/** Resolve + scope-check the objective (must belong to this org + project). */
async function loadObjective(orgId: string, projectId: string, objectiveId: string) {
  return prisma.objective.findFirst({
    where: { id: objectiveId, orgId, projectId },
    select: { id: true },
  });
}

/** GET — the deliverables + dependencies linked to this objective. */
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
      orderBy: { createdAt: "asc" },
    });

    const workItemIds = links
      .filter((l) => l.kind === "WORK_ITEM" && l.workItemId)
      .map((l) => l.workItemId!);
    const dependsOnIds = links
      .filter((l) => l.kind === "DEPENDS_ON" && l.dependsOnObjectiveId)
      .map((l) => l.dependsOnObjectiveId!);

    const [items, deps] = await Promise.all([
      workItemIds.length
        ? prisma.workItem.findMany({
            where: { id: { in: workItemIds }, orgId, projectId },
            select: { id: true, ticketNumber: true, title: true, columnKey: true, completedAt: true },
          })
        : Promise.resolve([]),
      dependsOnIds.length
        ? prisma.objective.findMany({
            where: { id: { in: dependsOnIds }, orgId, projectId },
            select: { id: true, title: true, status: true, progress: true },
          })
        : Promise.resolve([]),
    ]);

    return success({ workItems: items, dependencies: deps });
  } catch (e) {
    return handleApiError(e);
  }
}

/** POST — link a work item or a dependency to this objective (idempotent). */
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

    const { kind, targetId } = bodySchema.parse(await request.json());

    if (kind === "WORK_ITEM") {
      // The work item must belong to this project (no cross-project links).
      const item = await prisma.workItem.findFirst({
        where: { id: targetId, orgId, projectId },
        select: { id: true },
      });
      if (!item)
        return new Response(JSON.stringify({ error: "Work item not in this project" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
    } else {
      // A dependency on another objective in this project; never on itself.
      if (targetId === objectiveId)
        return new Response(JSON.stringify({ error: "An objective can't depend on itself" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      const dep = await prisma.objective.findFirst({
        where: { id: targetId, orgId, projectId },
        select: { id: true },
      });
      if (!dep)
        return new Response(JSON.stringify({ error: "Objective not in this project" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
    }

    // Idempotent: the (objectiveId, kind, target) columns are nullable so we
    // guard with a findFirst rather than a DB unique constraint.
    const targetWhere =
      kind === "WORK_ITEM" ? { workItemId: targetId } : { dependsOnObjectiveId: targetId };
    const existing = await prisma.objectiveLink.findFirst({
      where: { objectiveId, kind, ...targetWhere },
      select: { id: true },
    });
    if (existing) return created({ linkId: existing.id });

    const link = await prisma.objectiveLink.create({
      data: { objectiveId, kind, ...targetWhere },
      select: { id: true },
    });
    return created({ linkId: link.id });
  } catch (e) {
    return handleApiError(e);
  }
}

/** DELETE — unlink a work item or dependency from this objective. */
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

    const { kind, targetId } = bodySchema.parse(await request.json());
    const targetWhere =
      kind === "WORK_ITEM" ? { workItemId: targetId } : { dependsOnObjectiveId: targetId };
    await prisma.objectiveLink.deleteMany({ where: { objectiveId, kind, ...targetWhere } });
    return success({ ok: true });
  } catch (e) {
    return handleApiError(e);
  }
}
