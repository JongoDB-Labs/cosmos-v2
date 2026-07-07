import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireAccess } from "@/lib/abac/require-access";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { publishToOrg } from "@/lib/realtime/broker";
import { teamsNotify, escapeHtmlBasic } from "@/lib/integrations/teams-notify";
import { storeEmbedding } from "@/lib/rag/embed";
import { z } from "zod";
import { Priority, Prisma } from "@prisma/client";

const createItemSchema = z.object({
  workItemTypeId: z.string().uuid().nullish(),
  type: z.string().nullish(),
  title: z.string().min(1).max(500),
  description: z.string().nullish(),
  columnKey: z.string(),
  assigneeId: z.string().uuid().nullable().optional(),
  // Multi-assign (FR 1d38496a): full assignee set; first entry becomes the
  // primary `assigneeId`. When present it wins over the legacy single field.
  assigneeIds: z.array(z.string().uuid()).max(50).optional(),
  priority: z.nativeEnum(Priority).default(Priority.MEDIUM),
  cycleId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  storyPoints: z.number().int().min(0).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  tags: z.array(z.string()).optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

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
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_READ);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const sp = request.nextUrl.searchParams;
    const where: Record<string, unknown> = { orgId, projectId };

    if (sp.get("workItemTypeId")) where.workItemTypeId = sp.get("workItemTypeId");
    if (sp.get("priority")) where.priority = sp.get("priority");
    if (sp.get("columnKey")) where.columnKey = sp.get("columnKey");
    if (sp.get("assigneeId")) where.assigneeId = sp.get("assigneeId");
    if (sp.get("cycleId")) where.cycleId = sp.get("cycleId");
    if (sp.get("parentId")) where.parentId = sp.get("parentId");

    if (sp.get("search")) {
      where.title = { contains: sp.get("search"), mode: "insensitive" };
    }

    const items = await prisma.workItem.findMany({
      where,
      include: {
        parent: { select: { id: true, title: true, ticketNumber: true, workItemTypeId: true } },
        children: { select: { id: true, title: true, columnKey: true, ticketNumber: true, workItemTypeId: true } },
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

    return success(items);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = createItemSchema.parse(body);

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
          return NextResponse.json(
            { error: `No work item type found for "${data.type ?? "TASK"}"` },
            { status: 400 },
          );
        }
        resolvedTypeId = fallback.id;
      } else {
        resolvedTypeId = wit.id;
      }
    }

    const item = await prisma.$transaction(async (tx) => {
      const maxTicket = await tx.workItem.aggregate({
        where: { orgId, projectId },
        _max: { ticketNumber: true },
      });
      const ticketNumber = (maxTicket._max.ticketNumber ?? 0) + 1;

      const maxSort = await tx.workItem.aggregate({
        where: { orgId, projectId, columnKey: data.columnKey },
        _max: { sortOrder: true },
      });
      const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;

      // Full assignee set: explicit list wins; a legacy single assigneeId
      // becomes a one-member set. First member is the primary.
      const assigneeIds =
        data.assigneeIds ?? (data.assigneeId ? [data.assigneeId] : []);

      const created = await tx.workItem.create({
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
          cycleId: data.cycleId ?? null,
          parentId: data.parentId ?? null,
          ticketNumber,
          storyPoints: data.storyPoints ?? null,
          sortOrder,
          dueDate: data.dueDate ? new Date(data.dueDate) : null,
          startDate: data.startDate ? new Date(data.startDate) : null,
          columnEnteredAt: new Date(),
          tags: data.tags ?? [],
          customFields: (data.customFields ?? {}) as Prisma.InputJsonValue,
          createdById: ctx.userId,
        },
        include: {
          children: { select: { id: true, title: true, columnKey: true, workItemTypeId: true } },
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
      });

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

    return created(item);
  } catch (error) {
    return handleApiError(error);
  }
}
