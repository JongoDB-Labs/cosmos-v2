import { NextRequest } from "next/server";
import { z } from "zod";
import { ObjectiveStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { krProgressPercent, objectiveProgressPercent } from "@/lib/okr/progress";
import { objectiveHealth } from "@/lib/okr/health";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.OKR_READ);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return new Response("Not found", { status: 404 });

    const objectives = await prisma.objective.findMany({
      where: { orgId, projectId },
      include: {
        keyResults: {
          orderBy: { sortOrder: "asc" },
          include: {
            links: {
              select: {
                workItem: {
                  select: { id: true, ticketNumber: true, title: true, columnKey: true, completedAt: true },
                },
              },
            },
          },
        },
        // COSMOS-82: work items linked directly to the objective, plus the other
        // objectives it depends on. Soft references, so we resolve the far ends
        // below and drop any that no longer exist.
        links: {
          select: {
            kind: true,
            workItemId: true,
            dependsOnObjectiveId: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });

    // Resolve every directly-linked work item in one query (across all
    // objectives), scoped to this org+project so a stale/foreign id resolves to
    // nothing. Dependency targets are other objectives in this same list.
    const directItemIds = [
      ...new Set(
        objectives.flatMap((o) =>
          o.links.filter((l) => l.kind === "WORK_ITEM" && l.workItemId).map((l) => l.workItemId!),
        ),
      ),
    ];
    const directItems = directItemIds.length
      ? await prisma.workItem.findMany({
          where: { id: { in: directItemIds }, orgId, projectId },
          select: { id: true, ticketNumber: true, title: true, columnKey: true, completedAt: true },
        })
      : [];
    const itemById = new Map(directItems.map((w) => [w.id, w]));

    // FR a94ff583 + COSMOS-82: a Key Result with linked tickets AUTO-tracks — its
    // current value becomes the count of its linked tickets that are done. The
    // objective progress rolls up from the (possibly auto-derived) KR values AND
    // any work items linked directly to the objective, and health is derived from
    // that progress vs. the objective's target date.
    const shaped = objectives.map((o) => {
      const keyResults = o.keyResults.map((kr) => {
        const linkedItems = kr.links.map((l) => l.workItem);
        const linkedTotal = linkedItems.length;
        const linkedDone = linkedItems.filter((w) => w.completedAt != null).length;
        const currentValue = linkedTotal > 0 ? linkedDone : kr.currentValue;
        return {
          ...kr,
          links: undefined,
          currentValue,
          autoTracked: linkedTotal > 0,
          linkedTotal,
          linkedDone,
          linkedItems,
        };
      });

      // Direct objective→work-item links (deliverables), danglers dropped.
      const directLinked = o.links
        .filter((l) => l.kind === "WORK_ITEM" && l.workItemId)
        .map((l) => itemById.get(l.workItemId!))
        .filter((w): w is NonNullable<typeof w> => w != null);
      const linkedTotal = directLinked.length;
      const linkedDone = directLinked.filter((w) => w.completedAt != null).length;

      const krPercents = keyResults.map((kr) =>
        krProgressPercent(kr.startValue, kr.currentValue, kr.targetValue, kr.lowerIsBetter),
      );
      const progress = objectiveProgressPercent(krPercents, linkedTotal, linkedDone);

      const dependsOnIds = o.links
        .filter((l) => l.kind === "DEPENDS_ON" && l.dependsOnObjectiveId)
        .map((l) => l.dependsOnObjectiveId!);

      return {
        ...o,
        links: undefined,
        keyResults,
        progress,
        linkedItems: directLinked,
        linkedTotal,
        linkedDone,
        dependsOnIds,
        health: objectiveHealth(progress, o.targetDate, o.status, o.createdAt),
      };
    });

    // Second pass: resolve dependency ids to the (already-shaped) objectives so
    // each dependency carries its title/status/progress. Danglers drop out.
    const shapedById = new Map(shaped.map((o) => [o.id, o]));
    const withDeps = shaped.map(({ dependsOnIds, ...o }) => ({
      ...o,
      dependencies: dependsOnIds
        .map((id) => shapedById.get(id))
        .filter((d): d is NonNullable<typeof d> => d != null)
        .map((d) => ({ id: d.id, title: d.title, status: d.status, progress: d.progress })),
    }));

    return success(withDeps);
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  period: z.string().nullish(),
  status: z.nativeEnum(ObjectiveStatus).default(ObjectiveStatus.ACTIVE),
  parentId: z.string().uuid().nullish(),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.OKR_CREATE);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return new Response("Not found", { status: 404 });

    const data = createSchema.parse(await request.json());

    // Append to the end of the project's manual order.
    const last = await prisma.objective.findFirst({
      where: { orgId, projectId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const sortOrder = last ? last.sortOrder + 1 : 0;

    const created = await prisma.objective.create({
      data: {
        orgId,
        projectId,
        title: data.title,
        description: data.description ?? null,
        period: data.period ?? null,
        status: data.status,
        parentId: data.parentId ?? null,
        progress: 0,
        sortOrder,
      },
      include: { keyResults: { orderBy: { sortOrder: "asc" } } },
    });

    return success(created);
  } catch (e) {
    return handleApiError(e);
  }
}

// Persist a manual reorder of the project's objectives. Body: an ordered list of
// objective IDs; each one's sort_order is set to its index. Scoped to this
// org+project so a stray/foreign id can't be renumbered.
const reorderSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.OKR_UPDATE);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
    });
    if (!project) return new Response("Not found", { status: 404 });

    const { orderedIds } = reorderSchema.parse(await request.json());

    // Only renumber ids that genuinely belong to this project.
    const owned = await prisma.objective.findMany({
      where: { orgId, projectId, id: { in: orderedIds } },
      select: { id: true },
    });
    const ownedSet = new Set(owned.map((o) => o.id));

    await prisma.$transaction(
      orderedIds
        .filter((id) => ownedSet.has(id))
        .map((id, index) =>
          prisma.objective.update({ where: { id }, data: { sortOrder: index } }),
        ),
    );

    return success({ reordered: ownedSet.size });
  } catch (e) {
    return handleApiError(e);
  }
}
