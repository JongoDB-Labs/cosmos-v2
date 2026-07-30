import { NextRequest } from "next/server";
import { z } from "zod";
import { MilestoneStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; milestoneId: string }>;
};

function loadMilestone(orgId: string, projectId: string, milestoneId: string) {
  return prisma.milestone.findFirst({
    where: { id: milestoneId, orgId, projectId },
    // links: a date edit on a milestone that follows a ticket is redirected to
    // that ticket, so the PATCH needs to know whether it has exactly one.
    include: { links: true },
  });
}

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  dueDate: z.string().datetime().optional(),
  status: z.nativeEnum(MilestoneStatus).optional(),
  autoStatus: z.boolean().optional(),
  completedAt: z.string().datetime().nullish(),
  ownerId: z.string().uuid().nullish(),
  sortOrder: z.number().int().optional(),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, milestoneId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await loadMilestone(orgId, projectId, milestoneId);
    if (!existing) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());

    /**
     * A date change on a milestone that FOLLOWS a ticket is written to the
     * TICKET, not the milestone.
     *
     * The milestone's date is derived from its single linked work item's
     * planned end (see `milestoneDateSource`). Writing the milestone row here
     * would be overwritten by that derivation on the very next read — the edit
     * would appear to work and then silently revert. Writing the ticket instead
     * makes the change land in the one place every surface reads: the board,
     * the item's own detail sheet, the Gantt and the Release Timeline all move
     * together, which is what "change it across the org" means.
     *
     * Only when the milestone owns its date (no link, several links, or a
     * ticket with no planned end) does the milestone row take the write.
     */
    let dateWrittenToWorkItemId: string | null = null;
    if (data.dueDate !== undefined && existing.links.length === 1) {
      const workItemId = existing.links[0].workItemId;
      const item = await prisma.workItem.findFirst({
        where: { id: workItemId, orgId },
        select: { id: true, dueDate: true },
      });
      // `dueDate` non-null is the same condition milestoneDateSource follows on;
      // if the ticket has no planned end the milestone still owns its date.
      if (item?.dueDate) {
        await prisma.workItem.update({
          where: { id: item.id },
          data: { dueDate: new Date(data.dueDate) },
        });
        dateWrittenToWorkItemId = item.id;
      }
    }

    const updated = await prisma.milestone.update({
      where: { id: milestoneId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.dueDate !== undefined && dateWrittenToWorkItemId === null && { dueDate: new Date(data.dueDate) }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.autoStatus !== undefined && { autoStatus: data.autoStatus }),
        ...(data.completedAt !== undefined && {
          completedAt: data.completedAt ? new Date(data.completedAt) : null,
        }),
        ...(data.ownerId !== undefined && { ownerId: data.ownerId }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      },
      include: { links: true },
    });

    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, milestoneId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await loadMilestone(orgId, projectId, milestoneId);
    if (!existing) return new Response("Not found", { status: 404 });

    // Links cascade-delete via the FK.
    await prisma.milestone.delete({ where: { id: milestoneId } });

    return success({ id: milestoneId });
  } catch (e) {
    return handleApiError(e);
  }
}
