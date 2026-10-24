import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { requireAccess } from "@/lib/abac/require-access";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { teamProjectError } from "@/lib/teams/item-team.server";
import { applyWorkItemChange, workItemPatchSchema } from "@/lib/work-items/apply-change.server";
import { changeContextSchema } from "@/lib/workflow/transition-request";
import { runAfterCommit } from "@/lib/work-items/after-commit";
import { loadWorkItemDetail } from "@/lib/work-items/read.server";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { getWorkItem } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; itemId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, getWorkItem);
    const { params: { orgId, projectId, itemId } } = await parseRequest(getWorkItem, request, params);
    await requireProjectRead(ctx, projectId, "ITEM_READ");

    const item = await loadWorkItemDetail(ctx, orgId, projectId, itemId);
    if (!item) return problem(404, "not_found", undefined, { request });

    return respond(getWorkItem, 200, item);
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // The project first: a key's project scope and team-scoped access bind
    // edits as they bind reads, and an item id is not confirmed to a caller
    // who can't see its project.
    await requireProjectRead(ctx, projectId, "ITEM_UPDATE");

    const existing = await prisma.workItem.findFirst({ where: { id: itemId, orgId, projectId } });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz: checks ITEM_UPDATE in the bitfield AND applies any
    // work-role/member deny policy that references it (narrowing by ownership /
    // project membership). Identical to requirePermission until a policy exists.
    await requireAccess(ctx, "ITEM_UPDATE", {
      createdById: existing.createdById,
      assigneeId: existing.assigneeId,
      projectId,
    });

    const body = await request.json();
    const data = workItemPatchSchema.parse(body);
    const { transition, boardId } = changeContextSchema.parse(body);

    const teamError = await teamProjectError({ projectId, teamId: data.teamId });
    if (teamError) return Response.json({ error: teamError }, { status: 400 });

    const { item, effects } = await prisma.$transaction(async (tx) => {
      const change = await applyWorkItemChange(tx, {
        actorId: ctx.userId,
        orgId,
        projectId,
        itemIds: [itemId],
        patch: data,
        source: "API",
        actor: ctx,
        transition,
        boardId,
      });
      const updated = await tx.workItem.findUniqueOrThrow({
        where: { id: itemId },
        include: {
          // Keep the child-ref shape consistent with the GET routes (the detail
          // sheet renders `#{ticketNumber}` for each sub-item) so a PUT echo of a
          // parent doesn't strip ticket numbers off its cached sub-item list.
          children: { select: { id: true, title: true, columnKey: true, ticketNumber: true, workItemTypeId: true, completedAt: true }, orderBy: { sortOrder: "asc" } },
          workItemType: { select: { id: true, key: true, name: true, icon: true, color: true, celebrateOnComplete: true } },
          assignees: {
            orderBy: { sortOrder: "asc" },
            select: {
              userId: true,
              user: { select: { id: true, displayName: true, avatarUrl: true } },
            },
          },
          _count: { select: { comments: true, activities: true } },
        },
      });
      // The echo carries WHAT ELSE MOVED, and where it moved FROM. A cascade is
      // only reversible if the caller is told its full extent: the slip rule is
      // one-directional by design, so putting the dragged bar back cascades
      // nothing and would strand every item this just pushed. The Gantt's Undo
      // restores this set alongside the bar. Derived, not a column — and not
      // included in the row the PUT writes.
      return { item: { ...updated, scheduleCascade: change.scheduleCascade }, effects: change.effects };
    });

    await runAfterCommit(effects, { ipAddress: getIpAddress(request) });

    return success(item);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectVisible(ctx, projectId);

    const existing = await prisma.workItem.findFirst({ where: { id: itemId, orgId, projectId } });
    if (!existing) return new Response("Not found", { status: 404 });

    // Resource-aware authz (ITEM_DELETE + any narrowing deny policy).
    await requireAccess(ctx, "ITEM_DELETE", {
      createdById: existing.createdById,
      assigneeId: existing.assigneeId,
      projectId,
    });

    await prisma.workItem.delete({ where: { id: itemId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_item.deleted",
      entity: "work_item",
      entityId: itemId,
      metadata: { title: existing.title, ticketNumber: String(existing.ticketNumber) } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    try {
      publishToOrg(orgId, "work-item.deleted", {
        id: itemId,
        projectId,
        ticketNumber: existing.ticketNumber,
      });
    } catch {
      /* never let a broker error break the delete response */
    }

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
