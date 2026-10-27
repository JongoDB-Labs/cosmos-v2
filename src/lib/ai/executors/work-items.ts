import { prisma, prismaUnfiltered } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { storeEmbedding } from "@/lib/rag/embed";
import { applyWorkItemChange, type WorkItemPatch } from "@/lib/work-items/apply-change.server";
import { runAfterCommit } from "@/lib/work-items/after-commit";
import { listTransitions } from "@/lib/workflow/engine.server";
import { TransitionError } from "@/lib/workflow/contract";
import { createWorkItemRow } from "@/lib/work-items/write.server";
import {
  directedDependencyEdge,
  wouldCreateDependencyCycle,
  type DirectedEdge,
} from "@/lib/work-items/dependency-graph";
import { Prisma, Priority, LinkType } from "@prisma/client";
import { z } from "zod";
import { assertPermission, assertProjectRead, type ToolContext } from "./_ctx";
import { teamFilter } from "./teams";
import { calendarDateInput, toCalendarNoonUTC } from "../date-input";
import { allocateTicketNumber, allocateSortOrder } from "@/lib/work-items/allocate";
import { intervalRequirementError } from "@/lib/work-items/interval-required.server";

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
  parentId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
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
 * rather than naming a stranger, but UNFILTERED on the soft delete: an item
 * assigned to someone who has since left must keep naming them, or their whole
 * history reads as assigned to nobody. The org scope is what distinguishes the
 * two — a stranger stays unnameable, a former colleague does not. Selected
 * explicitly down to
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
  const members = await prismaUnfiltered.orgMember.findMany({
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

  // Same rule as the create API (COSMOS-205): the model gets the reason back
  // and can ask which sprint or PI the story belongs in.
  const needsInterval = await intervalRequirementError({
    projectId: data.projectId,
    workItemTypeId: resolvedTypeId,
    intervalId: data.intervalId,
  });
  if (needsInterval) return { error: needsInterval };

  const columnKey = data.columnKey ?? "todo";

  const item = await prisma.$transaction(async (tx) => {
    const ticketNumber = await allocateTicketNumber(tx, {
      orgId: ctx.orgId,
      projectId: data.projectId,
    });

    const sortOrder = await allocateSortOrder(tx, {
      orgId: ctx.orgId,
      projectId: data.projectId,
      columnKey,
    });

    const created = await createWorkItemRow(tx, {
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
    }, { actorId: ctx.userId, source: "AI" });

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

  // Dates are calendar days for the assistant: stored at noon UTC, as the
  // create path stores them, then written like any other edit.
  const toIso = (d: string | null | undefined) =>
    d === undefined ? undefined : (toCalendarNoonUTC(d)?.toISOString() ?? null);
  const patch: WorkItemPatch = {
    title: data.title,
    description: data.description,
    priority: data.priority,
    assigneeId: data.assigneeId,
    intervalId: data.intervalId,
    parentId: data.parentId,
    storyPoints: data.storyPoints,
    dueDate: toIso(data.dueDate),
    startDate: toIso(data.startDate),
    tags: data.tags,
    columnKey: data.columnKey,
  };
  for (const k of Object.keys(patch) as (keyof WorkItemPatch)[]) {
    if (patch[k] === undefined) delete patch[k];
  }

  // The same writer as the PUT route: done/started follow the destination
  // status's CATEGORY, the move is recorded in history, tags go through the
  // label catalogue, and the edit is audited and published like any other.
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const change = await applyWorkItemChange(tx, {
        actorId: ctx.userId,
        orgId: ctx.orgId,
        projectId: existing.projectId,
        itemIds: [existing.id],
        patch,
        source: "AI",
        actor: ctx.auth,
      });
      const item = await tx.workItem.findUniqueOrThrow({ where: { id: existing.id } });
      return { item, effects: change.effects };
    });
  } catch (e) {
    // The workflow's refusal, as the model can act on it: what blocked the
    // move and, for missing input, which fields to ask for (list_transitions
    // shows the rest).
    if (e instanceof TransitionError) return transitionRefusal(e);
    throw e;
  }
  const { item, effects } = result;
  await runAfterCommit(effects);

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

/**
 * A workflow refusal as the assistant sees it: the code to branch on, which
 * transition, the fields to ask for, the kinds of check that failed. Not the
 * messages: a check's message can quote item content (a sub-item's title), and
 * the model is told what to ask, not shown what the item holds.
 */
function transitionRefusal(e: TransitionError) {
  const b = e.body;
  return {
    error: TRANSITION_REFUSALS[b.code],
    code: b.code,
    ...(b.transition && { transitionId: b.transition.id }),
    ...(b.fields && { fields: b.fields.map((f) => ({ field: f.field, required: f.required, ...(f.options && { options: f.options.map((o) => o.value) }) })) }),
    ...(b.reasons && { failedChecks: b.reasons.map((r) => r.validator) }),
    ...(b.candidates && { candidates: b.candidates.map((c) => c.id) }),
  };
}

const TRANSITION_REFUSALS: Record<TransitionError["body"]["code"], string> = {
  transition_not_allowed: "The workflow has no way to that status from where the item is. Call list_transitions.",
  transition_ambiguous: "Several transitions lead there; call transition_item with one of the candidates.",
  transition_forbidden: "This user may not take that transition.",
  transition_invalid: "The transition's checks failed; tell the user which checks (failedChecks) and stop.",
  transition_input_required: "The transition needs input: ask the user for the listed fields, then call transition_item with them.",
  type_change_needs_status: "The new type's workflow doesn't have the item's status.",
};

async function itemForTransitions(itemId: unknown, ctx: ToolContext) {
  if (typeof itemId !== "string") return { error: "itemId is required" } as const;
  const item = await prisma.workItem.findFirst({ where: { id: itemId, orgId: ctx.orgId } });
  if (!item) return { error: "Work item not found" } as const;
  const outOfScope = await assertProjectRead(ctx, item.projectId, "ITEM_UPDATE");
  if (outOfScope) return { error: "Work item not found" } as const;
  return { item } as const;
}

/** The transitions the user may take on an item, with what each asks for. */
export async function listTransitionsForItem(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_UPDATE);
  if (denied) return denied;
  const found = await itemForTransitions(input.itemId, ctx);
  if ("error" in found) return found;
  const transitions = await prisma.$transaction((tx) =>
    listTransitions(tx, { orgId: ctx.orgId, projectId: found.item.projectId, actor: ctx.auth, item: found.item }),
  );
  return {
    itemId: found.item.id,
    transitions: transitions.map((t) => ({
      id: t.id,
      name: t.name,
      to: t.to,
      toCategory: t.toCategory,
      requiresInput: t.input.some((f) => f.required),
      input: t.input.map((f) => ({ field: f.field, required: f.required, ...(f.options && { options: f.options.map((o) => o.value) }) })),
    })),
  };
}

const transitionItemSchema = z.object({
  itemId: z.string().uuid(),
  transitionId: z.string().min(1).max(64),
  input: z.record(z.string().max(120), z.unknown()).optional(),
});

/** Take a named transition, with the input it asked for. */
export async function transitionItem(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_UPDATE);
  if (denied) return denied;
  const parsed = transitionItemSchema.safeParse(input);
  if (!parsed.success) return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  const found = await itemForTransitions(parsed.data.itemId, ctx);
  if ("error" in found) return found;
  const { item: existing } = found;

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      // Only a transition this user is offered: hidden and restricted ones are not.
      const offered = await listTransitions(tx, { orgId: ctx.orgId, projectId: existing.projectId, actor: ctx.auth, item: existing });
      const t = offered.find((o) => o.id === parsed.data.transitionId);
      if (!t) throw new TransitionError({ error: "That transition isn't available.", code: "transition_not_allowed" });
      const change = await applyWorkItemChange(tx, {
        actorId: ctx.userId,
        orgId: ctx.orgId,
        projectId: existing.projectId,
        itemIds: [existing.id],
        patch: { columnKey: t.to },
        source: "AI",
        actor: ctx.auth,
        transition: { id: t.id, input: parsed.data.input },
      });
      const item = await tx.workItem.findUniqueOrThrow({ where: { id: existing.id } });
      return { item, effects: change.effects };
    });
  } catch (e) {
    if (e instanceof TransitionError) return transitionRefusal(e);
    throw e;
  }
  await runAfterCommit(result.effects);
  return {
    updated: true,
    id: result.item.id,
    ticketNumber: result.item.ticketNumber,
    title: result.item.title,
    columnKey: result.item.columnKey,
    assigneeId: result.item.assigneeId,
    completedAt: result.item.completedAt,
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
  if (data.parentId) where.parentId = data.parentId;
  if (data.teamId) {
    const team = await teamFilter(ctx.orgId, data.teamId, [data.projectId]);
    if ("error" in team) return team;
    // Appended, not assigned, so a later AND clause added above can't be lost.
    const and = where.AND ? (Array.isArray(where.AND) ? where.AND : [where.AND]) : [];
    where.AND = [...and, team.where];
  }

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
      parentId: true,
      teamId: true,
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
