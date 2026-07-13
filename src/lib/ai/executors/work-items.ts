import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { storeEmbedding } from "@/lib/rag/embed";
import { syncFeedbackForWorkItems } from "@/lib/feedback/status-sync";
import {
  directedDependencyEdge,
  wouldCreateDependencyCycle,
  type DirectedEdge,
} from "@/lib/work-items/dependency-graph";
import { Prisma, Priority, LinkType } from "@prisma/client";
import { z } from "zod";
import { assertPermission, type ToolContext } from "./_ctx";

// ─── Schemas ─────────────────────────────────────────────────────────────

const createWorkItemSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(500),
  type: z.string().optional(),
  workItemTypeId: z.string().uuid().optional(),
  columnKey: z.string().optional(),
  description: z.string().optional(),
  priority: z.nativeEnum(Priority).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  cycleId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  storyPoints: z.number().int().min(0).nullable().optional(),
});

const updateWorkItemSchema = z.object({
  itemId: z.string().uuid(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  priority: z.nativeEnum(Priority).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  cycleId: z.string().uuid().nullable().optional(),
  columnKey: z.string().optional(),
  storyPoints: z.number().int().min(0).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  startDate: z.string().datetime().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

const deleteWorkItemSchema = z.object({
  itemId: z.string().uuid(),
});

const listWorkItemsSchema = z.object({
  projectId: z.string().uuid(),
  columnKey: z.string().optional(),
  assigneeId: z.string().uuid().optional(),
  type: z.string().optional(),
  search: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Self-referential assignee tokens. When the model (or a user) passes one of
 * these as `assigneeId`, resolve it to the INVOKING user's id so "assign a
 * ticket to me" works without the model knowing/echoing the uuid. Any other
 * string passes through untouched (and is then uuid-validated as before).
 */
const SELF_ASSIGNEE_TOKENS = new Set(["me", "@me", "self", "@self", "myself", "current user", "current_user"]);

function resolveSelfAssignee(
  input: Record<string, unknown>,
  userId: string
): Record<string, unknown> {
  const a = input.assigneeId;
  if (typeof a === "string" && SELF_ASSIGNEE_TOKENS.has(a.trim().toLowerCase())) {
    return { ...input, assigneeId: userId };
  }
  return input;
}

/**
 * Resolve `type` (a short name like 'task' OR a full key like 'software.task'
 * OR a work-item-type UUID) to a concrete WorkItemType id for the given
 * project, honoring the project's template sector when present.
 *
 * Returns null when nothing matches — caller surfaces a friendly error.
 *
 * NOTE: this is sector-aware lookup (uses the project template's `sector`
 * prefix) but it deliberately does NOT carry over okr-dashboard's hardcoded
 * card-hierarchy auto-rules (no auto-creating "General" epics, no
 * auto-promoting stories to objectives).
 */
async function resolveWorkItemTypeId(
  projectId: string,
  typeOrId: string
): Promise<string | null> {
  // Already a uuid?
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(typeOrId)) {
    const exists = await prisma.workItemType.findUnique({
      where: { id: typeOrId },
      select: { id: true },
    });
    if (exists) return exists.id;
  }

  const normalized = typeOrId.trim().toLowerCase();

  // Sector-aware exact match
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { projectTemplateId: true },
  });
  let sector = "software";
  if (project?.projectTemplateId) {
    const tpl = await prisma.projectTemplate.findUnique({
      where: { id: project.projectTemplateId },
      select: { sector: true },
    });
    if (tpl?.sector) sector = tpl.sector;
  }

  const sectorMatch = await prisma.workItemType.findFirst({
    where: {
      isBuiltIn: true,
      key: normalized.includes(".") ? normalized : `${sector}.${normalized}`,
    },
    select: { id: true },
  });
  if (sectorMatch) return sectorMatch.id;

  // Fallback: any builtin type ending in `.${normalized}`
  const fallback = await prisma.workItemType.findFirst({
    where: { isBuiltIn: true, key: { endsWith: `.${normalized}` } },
    select: { id: true },
  });
  return fallback?.id ?? null;
}

// ─── Executors ───────────────────────────────────────────────────────────

export async function createWorkItem(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.ITEM_CREATE);
  if (denied) return denied;

  input = resolveSelfAssignee(input, ctx.userId);
  const parsed = createWorkItemSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const project = await prisma.project.findFirst({
    where: { id: data.projectId, orgId: ctx.orgId },
    select: { id: true },
  });
  if (!project) return { error: "Project not found" };

  let resolvedTypeId = data.workItemTypeId ?? null;
  if (!resolvedTypeId) {
    resolvedTypeId = await resolveWorkItemTypeId(
      data.projectId,
      data.type ?? "task"
    );
    if (!resolvedTypeId) {
      return { error: `No work item type found for "${data.type ?? "task"}"` };
    }
  }

  const columnKey = data.columnKey ?? "todo";

  const item = await prisma.$transaction(async (tx) => {
    const maxTicket = await tx.workItem.aggregate({
      where: { orgId: ctx.orgId, projectId: data.projectId },
      _max: { ticketNumber: true },
    });
    const ticketNumber = (maxTicket._max.ticketNumber ?? 0) + 1;

    const maxSort = await tx.workItem.aggregate({
      where: { orgId: ctx.orgId, projectId: data.projectId, columnKey },
      _max: { sortOrder: true },
    });
    const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;

    const created = await tx.workItem.create({
      data: {
        orgId: ctx.orgId,
        projectId: data.projectId,
        workItemTypeId: resolvedTypeId!,
        title: data.title,
        description: data.description ?? "",
        columnKey,
        assigneeId: data.assigneeId ?? null,
        priority: data.priority ?? Priority.MEDIUM,
        cycleId: data.cycleId ?? null,
        parentId: data.parentId ?? null,
        ticketNumber,
        storyPoints: data.storyPoints ?? null,
        sortOrder,
        columnEnteredAt: new Date(),
        createdById: ctx.userId,
      },
    });

    await tx.activity.create({
      data: {
        orgId: ctx.orgId,
        workItemId: created.id,
        userId: ctx.userId,
        action: "created",
      },
    });

    return created;
  });

  // RAG: embed-on-write. Runs AFTER the row is committed; best-effort.
  await storeEmbedding("work_items", item.id, `${item.title}\n${item.description}`).catch(() => {
    /* best-effort */
  });

  return {
    created: true,
    id: item.id,
    ticketNumber: item.ticketNumber,
    title: item.title,
    columnKey: item.columnKey,
    workItemTypeId: item.workItemTypeId,
  };
}

export async function updateWorkItem(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.ITEM_UPDATE);
  if (denied) return denied;

  input = resolveSelfAssignee(input, ctx.userId);
  const parsed = updateWorkItemSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const existing = await prisma.workItem.findFirst({
    where: { id: data.itemId, orgId: ctx.orgId },
  });
  if (!existing) return { error: "Work item not found" };

  const update: Prisma.WorkItemUpdateInput = {};
  if (data.title !== undefined) update.title = data.title;
  if (data.description !== undefined) update.description = data.description;
  if (data.priority !== undefined) update.priority = data.priority;
  if (data.assigneeId !== undefined) update.assigneeId = data.assigneeId;
  if (data.cycleId !== undefined) {
    update.cycle = data.cycleId
      ? { connect: { id: data.cycleId } }
      : { disconnect: true };
  }
  if (data.parentId !== undefined) {
    update.parent = data.parentId
      ? { connect: { id: data.parentId } }
      : { disconnect: true };
  }
  if (data.storyPoints !== undefined) update.storyPoints = data.storyPoints;
  if (data.dueDate !== undefined) update.dueDate = data.dueDate ? new Date(data.dueDate) : null;
  if (data.startDate !== undefined) update.startDate = data.startDate ? new Date(data.startDate) : null;
  if (data.tags !== undefined) update.tags = data.tags;

  const columnChanged = data.columnKey !== undefined && data.columnKey !== existing.columnKey;
  if (data.columnKey !== undefined) {
    update.columnKey = data.columnKey;
    if (columnChanged) update.columnEnteredAt = new Date();

    const isDone = ["done", "completed", "closed"].some((k) =>
      data.columnKey!.toLowerCase().includes(k)
    );
    if (isDone && !existing.completedAt) update.completedAt = new Date();
    else if (!isDone && existing.completedAt) update.completedAt = null;
  }

  const item = await prisma.workItem.update({
    where: { id: data.itemId },
    data: update,
  });

  // Column moves carry any linked feedback item along (best-effort inside).
  if (columnChanged) await syncFeedbackForWorkItems([item.id]);

  if (data.title !== undefined || data.description !== undefined) {
    await storeEmbedding("work_items", item.id, `${item.title}\n${item.description}`).catch(() => {
      /* best-effort */
    });
  }

  return {
    updated: true,
    id: item.id,
    ticketNumber: item.ticketNumber,
    title: item.title,
    columnKey: item.columnKey,
  };
}

export async function deleteWorkItem(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.ITEM_DELETE);
  if (denied) return denied;

  const parsed = deleteWorkItemSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }

  const existing = await prisma.workItem.findFirst({
    where: { id: parsed.data.itemId, orgId: ctx.orgId },
    select: { id: true, title: true, ticketNumber: true },
  });
  if (!existing) return { error: "Work item not found" };

  await prisma.workItem.delete({ where: { id: existing.id } });
  return { deleted: true, id: existing.id, ticketNumber: existing.ticketNumber, title: existing.title };
}

export async function listWorkItems(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.ITEM_READ);
  if (denied) return denied;

  const parsed = listWorkItemsSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const where: Prisma.WorkItemWhereInput = {
    orgId: ctx.orgId,
    projectId: data.projectId,
  };
  if (data.columnKey) where.columnKey = data.columnKey;
  if (data.assigneeId) where.assigneeId = data.assigneeId;
  if (data.search) where.title = { contains: data.search, mode: "insensitive" };

  if (data.type) {
    const typeId = await resolveWorkItemTypeId(data.projectId, data.type);
    if (typeId) where.workItemTypeId = typeId;
    // unresolved type → no results (don't 500)
    else return { count: 0, items: [] };
  }

  const limit = Math.min(data.limit ?? 50, 100);

  const items = await prisma.workItem.findMany({
    where,
    take: limit,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      ticketNumber: true,
      title: true,
      columnKey: true,
      priority: true,
      assigneeId: true,
      cycleId: true,
      storyPoints: true,
      dueDate: true,
      workItemTypeId: true,
      tags: true,
    },
  });

  return { count: items.length, items };
}

// ─── Work-item dependency links ────────────────────────────────────────────
// Directed edges between two work items in the SAME project. Mirrors
// `api/v1/orgs/[orgId]/projects/[projectId]/work-item-links/…`.

function linkInvalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

async function projectInOrgWi(projectId: string, orgId: string): Promise<boolean> {
  const project = await prisma.project.findFirst({ where: { id: projectId, orgId }, select: { id: true } });
  return Boolean(project);
}

const listItemLinksSchema = z.object({
  projectId: z.string().uuid(),
  itemId: z.string().uuid().optional(),
  limit: z.number().int().positive().optional(),
});

export async function listItemLinks(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_READ);
  if (denied) return denied;

  const parsed = listItemLinksSchema.safeParse(input);
  if (!parsed.success) return linkInvalid(parsed.error);
  const { projectId, itemId, limit } = parsed.data;

  if (!(await projectInOrgWi(projectId, ctx.orgId))) return { error: "Project not found" };

  const links = await prisma.workItemLink.findMany({
    where: {
      orgId: ctx.orgId,
      sourceItem: { projectId },
      ...(itemId ? { OR: [{ sourceItemId: itemId }, { targetItemId: itemId }] } : {}),
    },
    take: Math.min(limit ?? 100, 200),
    orderBy: { createdAt: "asc" },
    select: {
      id: true, type: true, sourceItemId: true, targetItemId: true, createdAt: true,
      sourceItem: { select: { ticketNumber: true, title: true } },
      targetItem: { select: { ticketNumber: true, title: true } },
    },
  });

  return {
    count: links.length,
    links: links.map((l) => ({
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
  };
}

const linkItemsSchema = z.object({
  projectId: z.string().uuid(),
  fromId: z.string().uuid(),
  toId: z.string().uuid(),
  type: z.nativeEnum(LinkType),
});

export async function linkItems(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_UPDATE);
  if (denied) return denied;

  const parsed = linkItemsSchema.safeParse(input);
  if (!parsed.success) return linkInvalid(parsed.error);
  const { projectId, fromId, toId, type } = parsed.data;

  if (fromId === toId) return { error: "A work item cannot link to itself" };
  if (!(await projectInOrgWi(projectId, ctx.orgId))) return { error: "Project not found" };

  // BOTH ends must be work items in THIS org+project (no cross-project edges).
  const ends = await prisma.workItem.findMany({
    where: { id: { in: [fromId, toId] }, orgId: ctx.orgId, projectId },
    select: { id: true },
  });
  if (ends.length !== 2) return { error: "Both items must be in this project" };

  // Same invalid-state guard as the REST route: reject an exact duplicate link
  // or a directed link that would form a circular dependency. Keeps the
  // no-cycles invariant true no matter who creates the link (UI or Cosmo).
  const existingLinks = await prisma.workItemLink.findMany({
    where: { orgId: ctx.orgId, sourceItem: { projectId } },
    select: { type: true, sourceItemId: true, targetItemId: true },
  });
  if (
    existingLinks.some(
      (l) => l.sourceItemId === fromId && l.targetItemId === toId && l.type === type,
    )
  ) {
    return { error: "These items are already linked with that relationship." };
  }
  const candidate = directedDependencyEdge(type, fromId, toId);
  if (candidate) {
    const edges = existingLinks
      .map((l) => directedDependencyEdge(l.type, l.sourceItemId, l.targetItemId))
      .filter((e): e is DirectedEdge => e !== null);
    if (wouldCreateDependencyCycle(edges, candidate)) {
      return {
        error:
          "This link would create a circular dependency — the two items would each depend on the other.",
      };
    }
  }

  const link = await prisma.workItemLink.create({
    data: { orgId: ctx.orgId, sourceItemId: fromId, targetItemId: toId, type },
    select: { id: true, type: true, sourceItemId: true, targetItemId: true, createdAt: true },
  });
  return { created: true, id: link.id, link };
}

const unlinkItemsSchema = z.object({
  projectId: z.string().uuid(),
  linkId: z.string().uuid(),
});

export async function unlinkItems(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_UPDATE);
  if (denied) return denied;

  const parsed = unlinkItemsSchema.safeParse(input);
  if (!parsed.success) return linkInvalid(parsed.error);
  const { projectId, linkId } = parsed.data;

  // Scope the link to this org + project (via its source item's project).
  const existing = await prisma.workItemLink.findFirst({
    where: { id: linkId, orgId: ctx.orgId, sourceItem: { projectId } },
    select: { id: true },
  });
  if (!existing) return { error: "Link not found" };

  await prisma.workItemLink.delete({ where: { id: existing.id } });
  return { deleted: true, id: existing.id };
}
