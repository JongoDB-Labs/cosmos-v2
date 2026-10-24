import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { createWorkItemRow } from "@/lib/work-items/write.server";
import { assertAssigneesInOrg } from "@/lib/work-items/apply-change.server";
import { requireAccess } from "@/lib/abac/require-access";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { teamsNotify, escapeHtmlBasic } from "@/lib/integrations/teams-notify";
import { storeEmbedding } from "@/lib/rag/embed";
import { setWorkItemLabels } from "@/lib/work-items/labels";
import { teamProjectError } from "@/lib/teams/item-team.server";
import { intervalRequirementError } from "@/lib/work-items/interval-required.server";
import {
  allocateTicketNumber,
  allocateSortOrder,
} from "@/lib/work-items/allocate";
import { Prisma } from "@prisma/client";
import { parseRequest, respond } from "@/lib/openapi/respond";
import { problem } from "@/lib/openapi/problem";
import { orgContext } from "@/lib/openapi/org-context";
import { createWorkItem, listProjectWorkItems } from "./route.contract";

const TYPE_NAME_MAP: Record<string, string> = {
  TASK: "task",
  STORY: "story",
  BUG: "bug",
  EPIC: "epic",
  SUBTASK: "subtask",
};

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, listProjectWorkItems);
    const { params: { orgId, projectId }, query } = await parseRequest(listProjectWorkItems, request, params);
    // Resource-aware, matching the POST below. This used to be a bare
    // requirePermission(ITEM_READ) — a pure bitmask test that never consults
    // ctx.abacRules — so an `in_project` ITEM_READ deny was honoured by the
    // org-wide Issues surfaces (which narrow via getReadableProjectIds) and
    // silently ignored here, leaving the board readable by URL. Identical to
    // requirePermission until an org authors a policy referencing ITEM_READ.
    await requireProjectRead(ctx, projectId, "ITEM_READ");

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return problem(404, "not_found", undefined, { request });

    const where: Record<string, unknown> = { orgId, projectId };

    // Archived items are out of the way by default. This route feeds the BOARD
    // surfaces (kanban, table, backlog, timeline), which query it directly
    // rather than through the shared where-builder — so the rule has to be
    // stated in both places, and `archive-filtering.test.ts` pins that it is.
    //
    // Same vocabulary as the shared builder: `?archived=only` selects them,
    // `?archived=all` (or the `?includeArchived=1` alias that shipped first)
    // shows both, anything else means active.
    if (query.archived === "only") where.archivedAt = { not: null };
    else if (query.archived !== "all" && query.includeArchived !== "1")
      where.archivedAt = null;

    // A blank filter is no filter, as before contracts.
    if (query.workItemTypeId) where.workItemTypeId = query.workItemTypeId;
    if (query.priority) where.priority = query.priority;
    if (query.columnKey) where.columnKey = query.columnKey;
    if (query.assigneeId) where.assigneeId = query.assigneeId;
    if (query.intervalId) where.intervalId = query.intervalId;
    if (query.parentId) where.parentId = query.parentId;

    if (query.search) {
      where.title = { contains: query.search, mode: "insensitive" };
    }

    const items = await prisma.workItem.findMany({
      where,
      // Full-text index internals, never part of the response (schemas.test).
      omit: { searchVector: true },
      include: {
        parent: { select: { id: true, title: true, ticketNumber: true, workItemTypeId: true } },
        children: { select: { id: true, title: true, columnKey: true, ticketNumber: true, workItemTypeId: true, completedAt: true } },
        workItemType: { select: { id: true, key: true, name: true, icon: true, color: true } },
        assignees: {
          orderBy: { sortOrder: "asc" },
          select: {
            userId: true,
            user: { select: { id: true, displayName: true, avatarUrl: true } },
          },
        },
        // (No `_count` of comments/activities — the list is fetched on every board
        // load and nothing on a card renders those counts, so the two per-row
        // subqueries were pure cost. Add back a scoped count if a badge needs it.)
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    });

    return respond(listProjectWorkItems, 200, items);
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { ctx } = await orgContext((await params).orgId, createWorkItem);
    const { params: { orgId, projectId }, body: data } = await parseRequest(createWorkItem, request, params);
    await requireProjectVisible(ctx, projectId);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return problem(404, "not_found", undefined, { request });

    // Resource-aware authz: checks ITEM_CREATE in the bitfield AND applies any
    // deny policy that references it. On create the actor is the creator, so
    // ownership binds trivially — this mainly enables in_project deny policies
    // via projectId. Identical to requirePermission until a policy exists.
    await requireAccess(ctx, "ITEM_CREATE", {
      createdById: ctx.userId,
      assigneeId: data.assigneeId ?? null,
      projectId,
    });

    let resolvedTypeId = data.workItemTypeId;
    if (!resolvedTypeId) {
      const typeName = TYPE_NAME_MAP[(data.type ?? "TASK").toUpperCase()] ?? (data.type ?? "task").toLowerCase();
      const project2 = await prisma.project.findUnique({
        where: { id: projectId },
        select: { projectTemplateId: true },
      });
      let sector = "software";
      if (project2?.projectTemplateId) {
        const tpl = await prisma.projectTemplate.findUnique({
          where: { id: project2.projectTemplateId },
          select: { sector: true },
        });
        if (tpl?.sector) sector = tpl.sector;
      }
      const wit = await prisma.workItemType.findFirst({
        where: {
          isBuiltIn: true,
          key: `${sector}.${typeName}`,
        },
        select: { id: true },
      });
      if (!wit) {
        const fallback = await prisma.workItemType.findFirst({
          where: { isBuiltIn: true, key: { endsWith: `.${typeName}` } },
          select: { id: true },
        });
        if (!fallback) {
          return problem(400, "invalid_request", `No work item type found for "${data.type ?? "TASK"}"`, { request });
        }
        resolvedTypeId = fallback.id;
      } else {
        resolvedTypeId = wit.id;
      }
    }

    const teamError = await teamProjectError({ projectId, teamId: data.teamId });
    if (teamError) return problem(400, "invalid_request", teamError, { request });

    // A Story or Feature needs an interval in a project that has any (COSMOS-205).
    const needsInterval = await intervalRequirementError({
      projectId,
      workItemTypeId: resolvedTypeId!,
      intervalId: data.intervalId,
    });
    if (needsInterval) return problem(400, "invalid_request", needsInterval, { request });

    const item = await prisma.$transaction(async (tx) => {
      const ticketNumber = await allocateTicketNumber(tx, { orgId, projectId });
      const sortOrder = await allocateSortOrder(tx, {
        orgId,
        projectId,
        columnKey: data.columnKey,
      });

      // Full assignee set: explicit list wins; a legacy single assigneeId
      // becomes a one-member set. First member is the primary.
      const assigneeIds =
        data.assigneeIds ?? (data.assigneeId ? [data.assigneeId] : []);
      // Every assignee must be in this org: the same 422 for an unknown id and
      // for a user elsewhere (no 500, no cross-tenant assignment).
      await assertAssigneesInOrg(tx, orgId, assigneeIds);

      const created = await createWorkItemRow(tx, {
        // An internal search index, not part of the item.
        omit: { searchVector: true },
        data: {
          orgId,
          projectId,
          workItemTypeId: resolvedTypeId!,
          title: data.title,
          description: data.description ?? "",
          columnKey: data.columnKey,
          assigneeId: assigneeIds[0] ?? null,
          assignees: {
            create: assigneeIds.map((userId, i) => ({ userId, sortOrder: i })),
          },
          priority: data.priority,
          intervalId: data.intervalId ?? null,
          teamId: data.teamId ?? null,
          parentId: data.parentId ?? null,
          ticketNumber,
          storyPoints: data.storyPoints ?? null,
          sortOrder,
          dueDate: data.dueDate ? new Date(data.dueDate) : null,
          startDate: data.startDate ? new Date(data.startDate) : null,
          // No auto-capture on CREATE: placing an item directly in an in-progress/
          // done column is usually backfilling existing state (import, board setup),
          // NOT a real transition — stamping actualStart/completedAt = now there
          // produced misleading "everything finished today" clusters. Only an explicit
          // value is honored here; a genuine drag-to-done later auto-captures in PUT.
          actualStart: data.actualStart ? new Date(data.actualStart) : null,
          completedAt: data.completedAt ? new Date(data.completedAt) : null,
          columnEnteredAt: new Date(),
          // Left empty here on purpose: setWorkItemLabels below is the only
          // writer of this array, and it needs the item's id to exist first.
          tags: [],
          customFields: (data.customFields ?? {}) as Prisma.InputJsonValue,
          createdById: ctx.userId,
        },
        include: {
          children: { select: { id: true, title: true, columnKey: true, workItemTypeId: true, completedAt: true } },
          workItemType: { select: { id: true, key: true, name: true, icon: true, color: true } },
          assignees: {
            orderBy: { sortOrder: "asc" },
            select: {
              userId: true,
              user: { select: { id: true, displayName: true, avatarUrl: true } },
            },
          },
          _count: { select: { comments: true, activities: true } },
        },
      }, { actorId: ctx.userId, source: "API" });

      // Labels go through the catalogue, so a ticket created with one produces a
      // real Label row rather than a string only this item knows about. The
      // resolved names are copied back onto the echoed object because they may
      // differ from what the caller sent — asking for "security" when the org's
      // label is "Security" stores, and should return, "Security".
      if (data.tags !== undefined && data.tags.length > 0) {
        const labels = await setWorkItemLabels(tx, orgId, created.id, data.tags, { actorId: ctx.userId, source: "API" });
        created.tags = labels.map((l) => l.name);
      }

      await tx.activity.create({
        data: {
          orgId,
          workItemId: created.id,
          userId: ctx.userId,
          action: "created",
        },
      });

      return created;
    });

    // RAG: embed-on-write. See notes/route.ts POST for the same pattern.
    // Runs AFTER the row is committed; best-effort.
    await storeEmbedding("work_items", item.id, `${item.title}\n${item.description}`).catch(
      (err: unknown) =>
        console.warn("[rag] failed to persist work item embedding:", (err as Error).message)
    );

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "work_item.created",
      entity: "work_item",
      entityId: item.id,
      metadata: {
        title: data.title,
        workItemTypeId: resolvedTypeId!,
        ticketNumber: String(item.ticketNumber),
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    try {
      publishToOrg(orgId, "work-item.created", {
        id: item.id,
        projectId,
        title: item.title,
        workItemTypeId: item.workItemTypeId,
        columnKey: item.columnKey,
        ticketNumber: item.ticketNumber,
      });
    } catch {
      /* never let a broker error break the create response */
    }

    // Teams notification (FR 8a162fe7): new item — OFF by default (noisy);
    // gated + best-effort inside teamsNotify.
    void teamsNotify(
      orgId,
      "itemCreated",
      `\u{1F195} <b>${project.key}-${item.ticketNumber}</b> ${escapeHtmlBasic(item.title)} created (${item.priority})`,
    );

    return respond(createWorkItem, 201, item);
  } catch (error) {
    return handleApiError(error, request);
  }
}
