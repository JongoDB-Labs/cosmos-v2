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
import { assertPermission, assertProjectRead, type ToolContext } from "./_ctx";
import { calendarDateInput, toCalendarNoonUTC } from "../date-input";

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
  intervalId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  storyPoints: z.number().int().min(0).nullable().optional(),
  dueDate: calendarDateInput.nullable().optional(),
  startDate: calendarDateInput.nullable().optional(),
});

const updateWorkItemSchema = z.object({
  itemId: z.string().uuid(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  priority: z.nativeEnum(Priority).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  intervalId: z.string().uuid().nullable().optional(),
  columnKey: z.string().optional(),
  storyPoints: z.number().int().min(0).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  dueDate: calendarDateInput.nullable().optional(),
  startDate: calendarDateInput.nullable().optional(),
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
 * Display names for a set of assignee ids, from THIS org's member directory.
 *
 * COSMOS-192: these executors only ever handed back the raw `assigneeId`, so
 * Cosmo's own report of what it had just done named a GUID ("assigned to
 * 4e62cb3e-…"). The stored id is correct — it simply had no name attached to
 * it. Resolve it the same way every UI surface does (`User.displayName`) and
 * return the name alongside the id.
 *
 * Scoped through OrgMember so an id from another tenant resolves to NOTHING
 * rather than naming a stranger, and selected explicitly down to
 * `user.displayName` — never OrgMember.permissions, which is a decimal-string
 * permission mask and must not ride out in a tool result.
 *
 * EGRESS: a person's name is PII, so `assigneeName` is deliberately NOT added
 * to `EXPOSABLE_FIELDS` in egress/projection.ts — a withheld (gov) result keeps
 * dropping it by default-deny, exactly as it drops `title` today. Only the
 * commercial-unclassified path, which already shows the model this same
 * directory via `list_org_members`, ever sees it.
 */
async function assigneeNames(
  orgId: string,
  userIds: readonly string[]
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const members = await prisma.orgMember.findMany({
    where: { orgId, userId: { in: ids } },
    select: { userId: true, user: { select: { displayName: true } } },
  });
  return new Map(members.map((m) => [m.userId, m.user.displayName] as const));
}

/** One id → its display name, or null when the directory has no name for it. */
async function assigneeName(orgId: string, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  return (await assigneeNames(orgId, [userId])).get(userId) || null;
}

/**
 * Refuse an assignee who is not in this org's directory.
 *
 * A well-formed uuid that names nobody here is exactly how a ticket ended up
 * "assigned to a GUID": the scalar stored happily and every surface that tried
 * to put a name to it came up empty. Same `{error} | null` shape as the gates in
 * _ctx.ts, and the message names the lookup tool so the model can recover — it
 * does NOT echo the offending id back.
 *
 * It also keeps the assignee SET writable: `WorkItemAssignee.userId` is a real
 * foreign key, so an id belonging to no user would otherwise surface as a raw
 * driver error instead of an answer.
 */
async function assertAssigneeInOrg(
  orgId: string,
  assigneeId: string | null | undefined
): Promise<{ error: string } | null> {
  if (!assigneeId) return null;
  const known = await assigneeNames(orgId, [assigneeId]);
  if (known.has(assigneeId)) return null;
  return {
    error:
      "That assigneeId is not a member of this organization. " +
      "Look the person up with list_org_members and pass their userId.",
  };
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

  // Creating a ticket in a project you cannot open plants work in someone
  // else's board and confirms the project exists.
  const outOfScope = await assertProjectRead(ctx, data.projectId, "ITEM_CREATE");
  if (outOfScope) return { error: "Project not found" };

  const strangerAssignee = await assertAssigneeInOrg(ctx.orgId, data.assigneeId);
  if (strangerAssignee) return strangerAssignee;

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
        // Multi-assign: the SET (`WorkItemAssignee`) is what the ticket's
        // Assignees control reads, and it is what the REST create route writes.
        // Setting only the legacy scalar left that set empty, so a ticket Cosmo
        // had just assigned opened on "Unassigned" (COSMOS-192).
        ...(data.assigneeId
          ? { assignees: { create: [{ userId: data.assigneeId, sortOrder: 0 }] } }
          : {}),
        priority: data.priority ?? Priority.MEDIUM,
        intervalId: data.intervalId ?? null,
        parentId: data.parentId ?? null,
        ticketNumber,
        storyPoints: data.storyPoints ?? null,
        dueDate: toCalendarNoonUTC(data.dueDate),
        startDate: toCalendarNoonUTC(data.startDate),
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
    assigneeId: item.assigneeId,
    assigneeName: await assigneeName(ctx.orgId, item.assigneeId),
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

  // The org check above only proves the row EXISTS. Its project may be
  // team-scoped and closed to this actor — see _ctx.ts. Same message either
  // way, so a refusal never confirms the row is real.
  const outOfScope = await assertProjectRead(ctx, existing.projectId, "ITEM_UPDATE");
  if (outOfScope) return { error: "Work item not found" };

  const strangerAssignee = await assertAssigneeInOrg(ctx.orgId, data.assigneeId);
  if (strangerAssignee) return strangerAssignee;

  const update: Prisma.WorkItemUpdateInput = {};
  if (data.title !== undefined) update.title = data.title;
  if (data.description !== undefined) update.description = data.description;
  if (data.priority !== undefined) update.priority = data.priority;
  if (data.assigneeId !== undefined) update.assigneeId = data.assigneeId;
  if (data.intervalId !== undefined) {
    update.interval = data.intervalId
      ? { connect: { id: data.intervalId } }
      : { disconnect: true };
  }
  if (data.parentId !== undefined) {
    update.parent = data.parentId
      ? { connect: { id: data.parentId } }
      : { disconnect: true };
  }
  if (data.storyPoints !== undefined) update.storyPoints = data.storyPoints;
  if (data.dueDate !== undefined) update.dueDate = toCalendarNoonUTC(data.dueDate);
  if (data.startDate !== undefined) update.startDate = toCalendarNoonUTC(data.startDate);
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

  const item = await prisma.$transaction(async (tx) => {
    // Keep the multi-assign SET in step with the legacy scalar, with the same
    // semantics the PUT route uses for a single `assigneeId`: null clears the
    // set, a user is promoted to the front of it (sortOrder -1, the set is read
    // ordered ascending). Without this the set kept whoever it held before —
    // and a Cosmo reassignment showed the OLD person on the ticket (COSMOS-192).
    if (data.assigneeId !== undefined) {
      if (data.assigneeId === null) {
        await tx.workItemAssignee.deleteMany({ where: { workItemId: data.itemId } });
      } else {
        await tx.workItemAssignee.upsert({
          where: { workItemId_userId: { workItemId: data.itemId, userId: data.assigneeId } },
          create: { workItemId: data.itemId, userId: data.assigneeId, sortOrder: -1 },
          update: { sortOrder: -1 },
        });
      }
    }
    return tx.workItem.update({ where: { id: data.itemId }, data: update });
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
    assigneeId: item.assigneeId,
    assigneeName: await assigneeName(ctx.orgId, item.assigneeId),
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
    select: { id: true, title: true, ticketNumber: true, projectId: true },
  });
  if (!existing) return { error: "Work item not found" };

  // The org check above only proves the row EXISTS. Its project may be
  // team-scoped and closed to this actor — see _ctx.ts. Same message either
  // way, so a refusal never confirms the row is real.
  const outOfScope = await assertProjectRead(ctx, existing.projectId, "ITEM_DELETE");
  if (outOfScope) return { error: "Work item not found" };

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

  // The projectId comes from the caller and only narrowed the query — it never
  // established that this actor may open that project.
  const outOfScope = await assertProjectRead(ctx, data.projectId, "ITEM_READ");
  if (outOfScope) return outOfScope;

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
      intervalId: true,
      storyPoints: true,
      dueDate: true,
      workItemTypeId: true,
      tags: true,
    },
  });

  // Name every assignee in one directory lookup, so a listing reads "Ryan
  // Beatty" rather than the id the model would otherwise have to echo.
  const names = await assigneeNames(
    ctx.orgId,
    items.map((i) => i.assigneeId).filter((id): id is string => id !== null)
  );

  return {
    count: items.length,
    items: items.map((i) => ({
      ...i,
      assigneeName: i.assigneeId ? (names.get(i.assigneeId) ?? null) : null,
    })),
  };
}

// ─── Work-item dependency links ────────────────────────────────────────────
// Directed edges between two work items in the SAME project. Mirrors
// `api/v1/orgs/[orgId]/projects/[projectId]/work-item-links/…`.

function linkInvalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

// The old `projectInOrgWi` helper asked whether a project EXISTS in the org, which is
// true of one the caller may not open — a project with `teamScopedAccess` is
// restricted to its members. Replaced by `assertProjectRead`, which forwards to
// the same `requireProjectRead` the HTTP routes use. See _ctx.ts.

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

  const outOfScope = await assertProjectRead(ctx, projectId, "ITEM_READ");
  if (outOfScope) return outOfScope;

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
  const outOfScope = await assertProjectRead(ctx, projectId, "ITEM_READ");
  if (outOfScope) return outOfScope;

  // BOTH ends must be work items in THIS org+project (no cross-project edges).
  const ends = await prisma.workItem.findMany({
    where: { id: { in: [fromId, toId] }, orgId: ctx.orgId, projectId },
    select: { id: true },
  });
  if (ends.length !== 2) return { error: "Both items must be in this project" };

  // Same invalid-state guard as the REST route: reject an exact duplicate link
  // or a directed link that would form a circular dependency. Keeps the
  // no-intervals invariant true no matter who creates the link (UI or Cosmo).
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

  // The `projectId` below narrows the lookup but is supplied by the CALLER, so
  // it constrains which link is found without establishing that the actor may
  // touch that project. Team scoping has to be checked separately.
  const outOfScope = await assertProjectRead(ctx, projectId, "ITEM_UPDATE");
  if (outOfScope) return { error: "Link not found" };

  // Scope the link to this org + project (via its source item's project).
  const existing = await prisma.workItemLink.findFirst({
    where: { id: linkId, orgId: ctx.orgId, sourceItem: { projectId } },
    select: { id: true },
  });
  if (!existing) return { error: "Link not found" };

  await prisma.workItemLink.delete({ where: { id: existing.id } });
  return { deleted: true, id: existing.id };
}
