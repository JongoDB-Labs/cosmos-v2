import { prisma } from "@/lib/db/client";
import { firePluginProjectCreate } from "@/lib/plugins/enablement";
import { getVisibleProjectIds } from "@/lib/rbac/project-access";
import { Permission } from "@/lib/rbac/permissions";
import { IntervalKind, SprintStatus, type Prisma } from "@prisma/client";
import { z } from "zod";
import { assertPermission, assertProjectRead, loadAuthContext, type ToolContext } from "./_ctx";
import { calendarDateInput, toCalendarNoonUTC } from "../date-input";
import { DEFAULT_COLUMNS } from "@/lib/boards/default-columns";
import { loadStatusCategories } from "@/lib/boards/status-categories.server";
import { seedBoardColumns } from "@/lib/workflow/provision.server";
import { buildIntervalReport } from "@/lib/intervals/interval-report";
import { isDoneStatus } from "@/lib/work-items/done-state";
import { updateWorkItems } from "@/lib/work-items/write.server";

const listProjectsSchema = z.object({
  includeArchived: z.boolean().optional(),
  // Fuzzy resolver: when present, match against project name + key SERVER-SIDE
  // and return only the matches (best first). This is how the CUI-blind model
  // resolves a project the user names in words ("the Acme Corp project") even
  // when the name/key are withheld from it by the egress gate — the match runs
  // here on the real values; the model only ever gets the resolved id.
  query: z.string().max(200).optional(),
});

/**
 * Score how well a project matches a free-text query, over its name AND key.
 * Higher = better; 0 = no match. Tokenized + case-insensitive so extra/misordered
 * words ("Acme Corp" → key "ACME"), partials, and key/name hits all resolve.
 */
function scoreProjectMatch(name: string, key: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const n = (name ?? "").toLowerCase();
  const k = (key ?? "").toLowerCase();
  const split = (s: string) => s.split(/[^a-z0-9]+/).filter(Boolean);
  const qTokens = split(q);
  const nTokens = split(n);
  let score = 0;

  if (q === k || q === n) score += 100;                       // exact key/name
  if (k.length >= 2 && qTokens.includes(k)) score += 60;      // "acme corp" contains key token "acme"
  if (k.length >= 2 && q.startsWith(k)) score += 20;          // key is a prefix of the phrase
  if (n.length > 0 && (q.includes(n) || n.includes(q))) score += 40; // whole-name containment either way

  // Token overlap with the name (each shared word is a signal).
  const nSet = new Set(nTokens);
  for (const qt of qTokens) {
    if (nSet.has(qt)) score += 15;
    else if (qt.length >= 3 && (k.startsWith(qt) || nTokens.some((nt) => nt.startsWith(qt)))) score += 5;
  }
  return score;
}

const listIntervalsSchema = z.object({
  projectId: z.string().uuid(),
  status: z.enum(["PLANNED", "ACTIVE", "COMPLETED"]).optional(),
  limit: z.number().int().positive().optional(),
});

const createIntervalSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(100),
  startDate: calendarDateInput,
  endDate: calendarDateInput,
  goal: z.string().optional(),
  intervalKind: z.nativeEnum(IntervalKind).optional(),
});

export async function listProjects(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.PROJECT_READ);
  if (denied) return denied;

  const parsed = listProjectsSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }

  const allProjects = await prisma.project.findMany({
    where: {
      orgId: ctx.orgId,
      ...(parsed.data.includeArchived ? {} : { archived: false }),
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      key: true,
      description: true,
      archived: true,
      enabledFeatures: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // The assistant must not narrate a project the asker cannot open. Same
  // helper GET /projects uses, fed the CALLER's AuthContext — so a key scoped to
  // one project lists that project only. The user-id variant this replaced
  // (`visibleProjectIdsForActor`) rebuilt the actor from the user and so listed
  // every project to a project-limited key.
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };
  const visible = await getVisibleProjectIds(
    auth,
    allProjects.map((p) => p.id),
  );
  const projects = allProjects.filter((p) => visible.has(p.id));

  // No query ⇒ unchanged behavior (all active projects, recent-first).
  const q = parsed.data.query?.trim();
  if (!q) return { count: projects.length, projects };

  // Fuzzy-resolve: keep only positive-scoring matches, best first. The scoring
  // runs on the real name/key here — the model only receives the resolved id
  // (name/key are still withheld downstream by the egress gate for gov tenants).
  const ranked = projects
    .map((p) => ({ p, score: scoreProjectMatch(p.name, p.key, q) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.p);

  return { count: ranked.length, projects: ranked };
}

export async function listIntervals(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.SPRINT_READ);
  if (denied) return denied;

  const parsed = listIntervalsSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const outOfScope = await assertProjectRead(ctx, data.projectId, "SPRINT_READ");
  if (outOfScope) return outOfScope;

  const where: Prisma.IntervalWhereInput = {
    orgId: ctx.orgId,
    projectId: data.projectId,
  };
  if (data.status) where.status = data.status;

  const intervals = await prisma.interval.findMany({
    where,
    orderBy: { number: "desc" },
    take: Math.min(data.limit ?? 20, 50),
    include: { _count: { select: { workItems: true } } },
  });

  return { count: intervals.length, intervals };
}

export async function createInterval(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.SPRINT_CREATE);
  if (denied) return denied;

  const parsed = createIntervalSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const outOfScope = await assertProjectRead(ctx, data.projectId, "SPRINT_CREATE");
  if (outOfScope) return outOfScope;

  const maxNumber = await prisma.interval.aggregate({
    where: { projectId: data.projectId },
    _max: { number: true },
  });
  const number = (maxNumber._max.number ?? 0) + 1;

  const interval = await prisma.interval.create({
    data: {
      orgId: ctx.orgId,
      projectId: data.projectId,
      number,
      name: data.name,
      goal: data.goal ?? "",
      startDate: toCalendarNoonUTC(data.startDate)!,
      endDate: toCalendarNoonUTC(data.endDate)!,
      intervalKind: data.intervalKind ?? IntervalKind.SPRINT,
    },
  });

  return {
    created: true,
    id: interval.id,
    number: interval.number,
    name: interval.name,
    startDate: interval.startDate,
    endDate: interval.endDate,
  };
}

// ── create_project ────────────────────────────────────────────────────────
const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  key: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Z][A-Z0-9]*$/, "Key must be uppercase alphanumeric"),
  description: z.string().nullish(),
});

export async function createProject(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_CREATE);
  if (denied) return denied;

  const parsed = createProjectSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  // Key uniqueness per org (mirrors the POST route's 409).
  const existing = await prisma.project.findUnique({
    where: { orgId_key: { orgId: ctx.orgId, key: data.key } },
    select: { id: true },
  });
  if (existing) return { error: "Project key already exists" };

  const project = await prisma.$transaction(async (tx) => {
    const proj = await tx.project.create({
      data: {
        orgId: ctx.orgId,
        name: data.name,
        key: data.key,
        description: data.description ?? null,
      },
      select: { id: true, archived: true, createdAt: true, updatedAt: true },
    });

    // Seed the default board + columns (non-template path of the route).
    const board = await tx.board.create({
      data: { orgId: ctx.orgId, projectId: proj.id, name: "Board", type: "KANBAN", sortOrder: 0 },
      select: { id: true, orgId: true, projectId: true, type: true },
    });
    await seedBoardColumns(tx, board, DEFAULT_COLUMNS);

    // Add the actor as a project MANAGER when they are an org member.
    const orgMember = await tx.orgMember.findUnique({
      where: { orgId_userId: { orgId: ctx.orgId, userId: ctx.userId } },
      select: { id: true },
    });
    if (orgMember) {
      await tx.projectMember.create({
        data: { projectId: proj.id, orgMemberId: orgMember.id, role: "MANAGER" },
      });
    }
    return proj;
  });

  // Same plugin hook the HTTP create path fires — a project made by the agent
  // must get the same per-plugin setup. Post-commit, best-effort inside.
  await firePluginProjectCreate(ctx.orgId, project.id);

  return { created: true, id: project.id, project };
}

// ── update_project ────────────────────────────────────────────────────────
const updateProjectSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullish(),
  archived: z.boolean().optional(),
});

export async function updateProject(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_UPDATE);
  if (denied) return denied;

  const parsed = updateProjectSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const outOfScope = await assertProjectRead(ctx, data.projectId, "PROJECT_UPDATE");
  if (outOfScope) return outOfScope;

  const updated = await prisma.project.update({
    // `data.projectId` rather than a re-fetched row: the gate above already
    // established the project is in this org AND reachable by this actor, so a
    // second lookup would only be a chance for the two to disagree.
    where: { id: data.projectId },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.archived !== undefined && { archived: data.archived }),
    },
    select: { id: true, archived: true, createdAt: true, updatedAt: true },
  });
  return { updated: true, id: updated.id, project: updated };
}

// ── update_interval ──────────────────────────────────────────────────────────
const updateIntervalSchema = z.object({
  projectId: z.string().uuid(),
  intervalId: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  goal: z.string().nullish(),
  startDate: calendarDateInput.nullish(),
  endDate: calendarDateInput.nullish(),
  status: z.nativeEnum(SprintStatus).optional(),
  parentId: z.string().uuid().nullable().optional(),
});

const CYCLE_SELECT = {
  id: true, number: true, status: true, intervalKind: true, startDate: true,
  endDate: true, projectId: true, parentId: true, name: true, createdAt: true,
} as const;

export async function updateInterval(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_UPDATE);
  if (denied) return denied;

  const parsed = updateIntervalSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const existing = await prisma.interval.findFirst({
    where: { id: data.intervalId, orgId: ctx.orgId, projectId: data.projectId },
    select: { id: true, projectId: true },
  });
  if (!existing) return { error: "Interval not found" };

  // The org check above only proves the row EXISTS. Its project may be
  // team-scoped and closed to this actor — see _ctx.ts. Same message either
  // way, so a refusal never confirms the row is real.
  const outOfScope = await assertProjectRead(ctx, existing.projectId, "SPRINT_UPDATE");
  if (outOfScope) return { error: "Interval not found" };

  // Re-parent validation: target must be a PROGRAM_INCREMENT in this project,
  // and an interval can't be its own parent (mirrors the PUT route).
  if (data.parentId !== undefined && data.parentId !== null) {
    if (data.parentId === data.intervalId) {
      return { error: "An interval can't be its own Program Increment" };
    }
    const parent = await prisma.interval.findFirst({
      where: { id: data.parentId, projectId: data.projectId },
      select: { intervalKind: true },
    });
    if (!parent || parent.intervalKind !== "PROGRAM_INCREMENT") {
      return { error: "A sprint can only be nested under a Program Increment" };
    }
  }

  // Only one ACTIVE interval per project.
  if (data.status === "ACTIVE") {
    const active = await prisma.interval.findFirst({
      where: { projectId: data.projectId, status: "ACTIVE", id: { not: data.intervalId } },
      select: { id: true },
    });
    if (active) return { error: "Another interval is already active" };
  }

  const updated = await prisma.interval.update({
    where: { id: existing.id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.goal !== undefined && { goal: data.goal ?? "" }),
      ...(data.startDate !== undefined && data.startDate !== null && { startDate: toCalendarNoonUTC(data.startDate)! }),
      ...(data.endDate !== undefined && data.endDate !== null && { endDate: toCalendarNoonUTC(data.endDate)! }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.parentId !== undefined && { parentId: data.parentId }),
    },
    select: CYCLE_SELECT,
  });
  return { updated: true, id: updated.id, interval: updated };
}

// ── complete_interval ────────────────────────────────────────────────────────
const completeIntervalSchema = z.object({
  projectId: z.string().uuid(),
  intervalId: z.string().uuid(),
  moveIncompleteToIntervalId: z.string().uuid().nullable().optional(),
});

export async function completeInterval(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_COMPLETE);
  if (denied) return denied;

  const parsed = completeIntervalSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const interval = await prisma.interval.findFirst({
    where: { id: data.intervalId, orgId: ctx.orgId, projectId: data.projectId },
    include: { workItems: true },
  });
  if (!interval) return { error: "Interval not found" };

  // Completing an interval rolls incomplete work forward — a write on the
  // project's plan. The org check above only proves the interval exists.
  const outOfScope = await assertProjectRead(ctx, interval.projectId, "SPRINT_COMPLETE");
  if (outOfScope) return { error: "Interval not found" };
  if (interval.status !== "ACTIVE") return { error: "Only active intervals can be completed" };

  const completed = await prisma.$transaction(async (tx) => {
    const items = interval.workItems;
    // The same report the Complete button records: done is the status's
    // CATEGORY, and the carried ids are kept for the review board.
    const statuses = await loadStatusCategories(tx, interval.projectId);
    const incompleteItems = items.filter((i) => !isDoneStatus(i.columnKey, statuses));
    const report = buildIntervalReport(items, new Date().toISOString(), statuses);

    if (incompleteItems.length > 0) {
      // Harden beyond the HTTP route (review finding): the destination interval is
      // untrusted, LLM-reachable input — require it to exist in THIS org+project
      // before re-pointing items at it; otherwise carry over to no interval.
      let destination: string | null = null;
      if (data.moveIncompleteToIntervalId) {
        const dest = await tx.interval.findFirst({
          where: { id: data.moveIncompleteToIntervalId, orgId: ctx.orgId, projectId: interval.projectId },
          select: { id: true },
        });
        if (!dest) throw new Error("moveIncompleteToIntervalId is not an interval in this project");
        destination = dest.id;
      }
      await updateWorkItems(tx, incompleteItems.map((i) => i.id), { intervalId: destination }, { actorId: ctx.userId, source: "AI" });
    }

    const row = await tx.interval.update({
      where: { id: interval.id },
      data: { status: "COMPLETED", report: report as unknown as Prisma.InputJsonValue },
      select: CYCLE_SELECT,
    });
    return { row, report };
  });

  return { completed: true, id: completed.row.id, interval: completed.row, report: completed.report };
}
