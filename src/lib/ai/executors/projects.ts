import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { CycleKind, SprintStatus, type ColumnCategory, type Prisma } from "@prisma/client";
import { z } from "zod";
import { assertPermission, type ToolContext } from "./_ctx";
import { calendarDateInput, toCalendarNoonUTC } from "../date-input";

const listProjectsSchema = z.object({
  includeArchived: z.boolean().optional(),
  // Fuzzy resolver: when present, match against project name + key SERVER-SIDE
  // and return only the matches (best first). This is how the CUI-blind model
  // resolves a project the user names in words ("the VITL BMA project") even
  // when the name/key are withheld from it by the egress gate — the match runs
  // here on the real values; the model only ever gets the resolved id.
  query: z.string().max(200).optional(),
});

/**
 * Score how well a project matches a free-text query, over its name AND key.
 * Higher = better; 0 = no match. Tokenized + case-insensitive so extra/misordered
 * words ("VITL BMA" → key "VITL"), partials, and key/name hits all resolve.
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
  if (k.length >= 2 && qTokens.includes(k)) score += 60;      // "vitl bma" contains key token "vitl"
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

const listCyclesSchema = z.object({
  projectId: z.string().uuid(),
  status: z.enum(["PLANNED", "ACTIVE", "COMPLETED"]).optional(),
  limit: z.number().int().positive().optional(),
});

const createCycleSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(100),
  startDate: calendarDateInput,
  endDate: calendarDateInput,
  goal: z.string().optional(),
  cycleKind: z.nativeEnum(CycleKind).optional(),
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

  const projects = await prisma.project.findMany({
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

export async function listCycles(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.SPRINT_READ);
  if (denied) return denied;

  const parsed = listCyclesSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const project = await prisma.project.findFirst({
    where: { id: data.projectId, orgId: ctx.orgId },
    select: { id: true },
  });
  if (!project) return { error: "Project not found" };

  const where: Prisma.CycleWhereInput = {
    orgId: ctx.orgId,
    projectId: data.projectId,
  };
  if (data.status) where.status = data.status;

  const cycles = await prisma.cycle.findMany({
    where,
    orderBy: { number: "desc" },
    take: Math.min(data.limit ?? 20, 50),
    include: { _count: { select: { workItems: true } } },
  });

  return { count: cycles.length, cycles };
}

export async function createCycle(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.SPRINT_CREATE);
  if (denied) return denied;

  const parsed = createCycleSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const project = await prisma.project.findFirst({
    where: { id: data.projectId, orgId: ctx.orgId },
    select: { id: true },
  });
  if (!project) return { error: "Project not found" };

  const maxNumber = await prisma.cycle.aggregate({
    where: { projectId: data.projectId },
    _max: { number: true },
  });
  const number = (maxNumber._max.number ?? 0) + 1;

  const cycle = await prisma.cycle.create({
    data: {
      orgId: ctx.orgId,
      projectId: data.projectId,
      number,
      name: data.name,
      goal: data.goal ?? "",
      startDate: toCalendarNoonUTC(data.startDate)!,
      endDate: toCalendarNoonUTC(data.endDate)!,
      cycleKind: data.cycleKind ?? CycleKind.SPRINT,
    },
  });

  return {
    created: true,
    id: cycle.id,
    number: cycle.number,
    name: cycle.name,
    startDate: cycle.startDate,
    endDate: cycle.endDate,
  };
}

// ── create_project ────────────────────────────────────────────────────────
// Default board columns for a project with no template (mirrors the POST route).
const DEFAULT_COLUMNS: { name: string; key: string; color: string; sortOrder: number; category: ColumnCategory }[] = [
  { name: "Backlog", key: "backlog", color: "#94a3b8", sortOrder: 0, category: "TODO" },
  { name: "To Do", key: "todo", color: "#60a5fa", sortOrder: 1, category: "TODO" },
  { name: "In Progress", key: "in-progress", color: "#fbbf24", sortOrder: 2, category: "IN_PROGRESS" },
  { name: "Review", key: "review", color: "#a78bfa", sortOrder: 3, category: "IN_PROGRESS" },
  { name: "Done", key: "done", color: "#34d399", sortOrder: 4, category: "DONE" },
];

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
      select: { id: true },
    });
    await tx.boardColumn.createMany({
      data: DEFAULT_COLUMNS.map((col) => ({ boardId: board.id, ...col })),
    });

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

  const existing = await prisma.project.findFirst({
    where: { id: data.projectId, orgId: ctx.orgId },
    select: { id: true },
  });
  if (!existing) return { error: "Project not found" };

  const updated = await prisma.project.update({
    where: { id: existing.id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.archived !== undefined && { archived: data.archived }),
    },
    select: { id: true, archived: true, createdAt: true, updatedAt: true },
  });
  return { updated: true, id: updated.id, project: updated };
}

// ── update_cycle ──────────────────────────────────────────────────────────
const updateCycleSchema = z.object({
  projectId: z.string().uuid(),
  cycleId: z.string().uuid(),
  name: z.string().min(1).max(100).optional(),
  goal: z.string().nullish(),
  startDate: calendarDateInput.nullish(),
  endDate: calendarDateInput.nullish(),
  status: z.nativeEnum(SprintStatus).optional(),
  parentId: z.string().uuid().nullable().optional(),
});

const CYCLE_SELECT = {
  id: true, number: true, status: true, cycleKind: true, startDate: true,
  endDate: true, projectId: true, parentId: true, name: true, createdAt: true,
} as const;

export async function updateCycle(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_UPDATE);
  if (denied) return denied;

  const parsed = updateCycleSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const existing = await prisma.cycle.findFirst({
    where: { id: data.cycleId, orgId: ctx.orgId, projectId: data.projectId },
    select: { id: true },
  });
  if (!existing) return { error: "Cycle not found" };

  // Re-parent validation: target must be a PROGRAM_INCREMENT in this project,
  // and a cycle can't be its own parent (mirrors the PUT route).
  if (data.parentId !== undefined && data.parentId !== null) {
    if (data.parentId === data.cycleId) {
      return { error: "A cycle can't be its own Program Increment" };
    }
    const parent = await prisma.cycle.findFirst({
      where: { id: data.parentId, projectId: data.projectId },
      select: { cycleKind: true },
    });
    if (!parent || parent.cycleKind !== "PROGRAM_INCREMENT") {
      return { error: "A sprint can only be nested under a Program Increment" };
    }
  }

  // Only one ACTIVE cycle per project.
  if (data.status === "ACTIVE") {
    const active = await prisma.cycle.findFirst({
      where: { projectId: data.projectId, status: "ACTIVE", id: { not: data.cycleId } },
      select: { id: true },
    });
    if (active) return { error: "Another cycle is already active" };
  }

  const updated = await prisma.cycle.update({
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
  return { updated: true, id: updated.id, cycle: updated };
}

// ── complete_cycle ────────────────────────────────────────────────────────
const completeCycleSchema = z.object({
  projectId: z.string().uuid(),
  cycleId: z.string().uuid(),
  moveIncompleteToCycleId: z.string().uuid().nullable().optional(),
});

export async function completeCycle(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.SPRINT_COMPLETE);
  if (denied) return denied;

  const parsed = completeCycleSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const data = parsed.data;

  const cycle = await prisma.cycle.findFirst({
    where: { id: data.cycleId, orgId: ctx.orgId, projectId: data.projectId },
    include: { workItems: true },
  });
  if (!cycle) return { error: "Cycle not found" };
  if (cycle.status !== "ACTIVE") return { error: "Only active cycles can be completed" };

  const completed = await prisma.$transaction(async (tx) => {
    const items = cycle.workItems;
    const isDone = (columnKey: string) =>
      ["done", "completed", "closed"].some((k) => columnKey.toLowerCase().includes(k));
    const doneItems = items.filter((i) => isDone(i.columnKey));
    const incompleteItems = items.filter((i) => !isDone(i.columnKey));

    const totalPoints = items.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);
    const completedPoints = doneItems.reduce((sum, i) => sum + (i.storyPoints ?? 0), 0);

    const report = {
      completedAt: new Date().toISOString(),
      totalItems: items.length,
      completedItems: doneItems.length,
      incompleteItems: incompleteItems.length,
      totalStoryPoints: totalPoints,
      completedStoryPoints: completedPoints,
      velocity: completedPoints,
      itemsByPriority: items.reduce((acc, i) => {
        acc[i.priority] = (acc[i.priority] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    };

    if (incompleteItems.length > 0) {
      // Harden beyond the HTTP route (review finding): the destination cycle is
      // untrusted, LLM-reachable input — require it to exist in THIS org+project
      // before re-pointing items at it; otherwise carry over to no cycle.
      let destination: string | null = null;
      if (data.moveIncompleteToCycleId) {
        const dest = await tx.cycle.findFirst({
          where: { id: data.moveIncompleteToCycleId, orgId: ctx.orgId, projectId: cycle.projectId },
          select: { id: true },
        });
        if (!dest) throw new Error("moveIncompleteToCycleId is not a cycle in this project");
        destination = dest.id;
      }
      await tx.workItem.updateMany({
        where: { id: { in: incompleteItems.map((i) => i.id) } },
        data: { cycleId: destination },
      });
    }

    const row = await tx.cycle.update({
      where: { id: cycle.id },
      data: { status: "COMPLETED", report },
      select: CYCLE_SELECT,
    });
    return { row, report };
  });

  return { completed: true, id: completed.row.id, cycle: completed.row, report: completed.report };
}
