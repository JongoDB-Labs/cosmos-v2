import { NextRequest } from "next/server";
import { z } from "zod";
import { MilestoneStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/**
 * Column keys that mean "not started" — an item sitting here doesn't count as
 * in-progress for auto-status. Everything else (other than `done`) is treated
 * as in-progress.
 */
const NOT_STARTED_COLUMNS = new Set(["backlog", "todo", "to-do"]);

type MilestoneWithLinks = Awaited<
  ReturnType<typeof loadMilestones>
>[number];

function loadMilestones(orgId: string, projectId: string) {
  return prisma.milestone.findMany({
    where: { orgId, projectId },
    include: { links: true },
    orderBy: { dueDate: "asc" },
  });
}

/**
 * Derive a milestone's status from its linked work items when `autoStatus` is
 * on. Rules (in order):
 *  - no links            → keep the stored status
 *  - all linked done     → COMPLETED
 *  - past due, not all done → MISSED
 *  - any link in progress → IN_PROGRESS
 *  - otherwise           → UPCOMING
 *
 * Dangling links (work items that no longer exist) are tolerated: they simply
 * don't appear in `columnByItemId` and are skipped.
 */
function deriveStatus(
  milestone: MilestoneWithLinks,
  columnByItemId: Map<string, string>,
  now: Date,
): { status: MilestoneStatus; completedAt: Date | null } {
  if (!milestone.autoStatus) {
    return { status: milestone.status, completedAt: milestone.completedAt };
  }

  const columns = milestone.links
    .map((l) => columnByItemId.get(l.workItemId))
    .filter((c): c is string => c !== undefined);

  if (columns.length === 0) {
    // No (resolvable) links — nothing to derive from, keep stored status.
    return { status: milestone.status, completedAt: milestone.completedAt };
  }

  const allDone = columns.every((c) => c === "done");
  if (allDone) {
    return { status: MilestoneStatus.COMPLETED, completedAt: milestone.completedAt ?? now };
  }

  const pastDue = milestone.dueDate.getTime() < now.getTime();
  if (pastDue) {
    return { status: MilestoneStatus.MISSED, completedAt: null };
  }

  const anyInProgress = columns.some(
    (c) => c !== "done" && !NOT_STARTED_COLUMNS.has(c),
  );
  if (anyInProgress) {
    return { status: MilestoneStatus.IN_PROGRESS, completedAt: null };
  }

  return { status: MilestoneStatus.UPCOMING, completedAt: null };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_READ);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const milestones = await loadMilestones(orgId, projectId);

    // Resolve the column for every linked work item in a single query so
    // auto-status derivation doesn't fan out per milestone.
    const linkedItemIds = Array.from(
      new Set(milestones.flatMap((m) => m.links.map((l) => l.workItemId))),
    );
    const columnByItemId = new Map<string, string>();
    if (linkedItemIds.length > 0) {
      const items = await prisma.workItem.findMany({
        where: { id: { in: linkedItemIds }, orgId, projectId },
        select: { id: true, columnKey: true },
      });
      for (const item of items) columnByItemId.set(item.id, item.columnKey);
    }

    const now = new Date();
    const withDerived = milestones.map((m) => {
      const { status, completedAt } = deriveStatus(m, columnByItemId, now);
      return { ...m, status, completedAt };
    });

    return success(withDerived);
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  dueDate: z.string().datetime(),
  ownerId: z.string().uuid().nullish(),
  autoStatus: z.boolean().optional(),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const data = createSchema.parse(await request.json());

    const maxSort = await prisma.milestone.aggregate({
      where: { orgId, projectId },
      _max: { sortOrder: true },
    });
    const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;

    const createdMilestone = await prisma.milestone.create({
      data: {
        orgId,
        projectId,
        title: data.title,
        description: data.description ?? null,
        dueDate: new Date(data.dueDate),
        ownerId: data.ownerId ?? null,
        autoStatus: data.autoStatus ?? true,
        sortOrder,
      },
      include: { links: true },
    });

    return success(createdMilestone);
  } catch (e) {
    return handleApiError(e);
  }
}
