import { prisma } from "@/lib/db/client";
import { GoalStatus, GoalProgressMode, KpiDirection } from "@prisma/client";
import { z } from "zod";
import { Permission } from "@/lib/rbac/permissions";
import { assertPermission, type ToolContext } from "./_ctx";

/**
 * Goals + KPIs executors. Every query is org+project scoped. Mirrors the routes
 * under `api/v1/orgs/[orgId]/projects/[projectId]/goals|kpis/…`.
 *
 * PERMISSIONS: no GOAL or KPI permission bits exist, so — per the brief — both
 * domains use the OKR planning bits (OKR_READ / OKR_CREATE / OKR_UPDATE). This
 * matches the goals HTTP routes; the KPI HTTP routes use ANALYTICS_READ /
 * PROJECT_UPDATE, so the assistant surface is intentionally OKR-uniform instead.
 */

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

async function projectInOrg(projectId: string, orgId: string): Promise<boolean> {
  const project = await prisma.project.findFirst({ where: { id: projectId, orgId }, select: { id: true } });
  return Boolean(project);
}

const GOAL_SELECT = {
  id: true, projectId: true, ownerId: true, status: true, progress: true, progressMode: true,
  targetDate: true, sortOrder: true, title: true, createdAt: true, updatedAt: true,
} as const;

const KPI_SELECT = {
  id: true, projectId: true, direction: true, autoSource: true, autoWindowDays: true,
  sortOrder: true, name: true, unit: true, targetValue: true, currentValue: true,
  createdAt: true, updatedAt: true,
} as const;

// ── list_goals ─────────────────────────────────────────────────────────
const listGoalsSchema = z.object({
  projectId: z.string().uuid(),
  limit: z.number().int().positive().optional(),
});

export async function listGoals(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_READ);
  if (denied) return denied;

  const parsed = listGoalsSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, limit } = parsed.data;

  if (!(await projectInOrg(projectId, ctx.orgId))) return { error: "Project not found" };

  const goals = await prisma.goal.findMany({
    where: { orgId: ctx.orgId, projectId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    take: Math.min(limit ?? 50, 100),
    select: GOAL_SELECT,
  });
  return { count: goals.length, goals };
}

// ── create_goal ─────────────────────────────────────────────────────────
const createGoalSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  status: z.nativeEnum(GoalStatus).default(GoalStatus.PLANNED),
  targetDate: z.string().datetime().nullish(),
  progressMode: z.nativeEnum(GoalProgressMode).default(GoalProgressMode.MANUAL),
  ownerId: z.string().uuid().nullish(),
});

export async function createGoal(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_CREATE);
  if (denied) return denied;

  const parsed = createGoalSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  if (!(await projectInOrg(data.projectId, ctx.orgId))) return { error: "Project not found" };

  const maxSort = await prisma.goal.aggregate({
    where: { orgId: ctx.orgId, projectId: data.projectId },
    _max: { sortOrder: true },
  });
  const created = await prisma.goal.create({
    data: {
      orgId: ctx.orgId,
      projectId: data.projectId,
      title: data.title,
      description: data.description ?? null,
      status: data.status,
      progressMode: data.progressMode,
      targetDate: data.targetDate ? new Date(data.targetDate) : null,
      ownerId: data.ownerId ?? null,
      progress: 0,
      sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
    },
    select: GOAL_SELECT,
  });
  return { created: true, id: created.id, goal: created };
}

// ── update_goal ─────────────────────────────────────────────────────────
const updateGoalSchema = z.object({
  projectId: z.string().uuid(),
  goalId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  status: z.nativeEnum(GoalStatus).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  targetDate: z.string().datetime().nullable().optional(),
  ownerId: z.string().uuid().nullish(),
});

export async function updateGoal(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_UPDATE);
  if (denied) return denied;

  const parsed = updateGoalSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const existing = await prisma.goal.findFirst({
    where: { id: data.goalId, orgId: ctx.orgId, projectId: data.projectId },
    select: { id: true },
  });
  if (!existing) return { error: "Goal not found" };

  const updated = await prisma.goal.update({
    where: { id: existing.id },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.progress !== undefined && { progress: data.progress }),
      ...(data.targetDate !== undefined && { targetDate: data.targetDate ? new Date(data.targetDate) : null }),
      ...(data.ownerId !== undefined && { ownerId: data.ownerId }),
    },
    select: GOAL_SELECT,
  });
  return { updated: true, id: updated.id, goal: updated };
}

// ── list_kpis ─────────────────────────────────────────────────────────
const listKpisSchema = z.object({
  projectId: z.string().uuid(),
  limit: z.number().int().positive().optional(),
});

export async function listKpis(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_READ);
  if (denied) return denied;

  const parsed = listKpisSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, limit } = parsed.data;

  if (!(await projectInOrg(projectId, ctx.orgId))) return { error: "Project not found" };

  const kpis = await prisma.kpi.findMany({
    where: { orgId: ctx.orgId, projectId },
    orderBy: { sortOrder: "asc" },
    take: Math.min(limit ?? 50, 100),
    select: KPI_SELECT,
  });
  return { count: kpis.length, kpis };
}

// ── create_kpi ─────────────────────────────────────────────────────────
const createKpiSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().nullish(),
  unit: z.string().max(50).optional(),
  targetValue: z.number().default(0),
  currentValue: z.number().default(0),
  direction: z.nativeEnum(KpiDirection).default(KpiDirection.UP_GOOD),
});

export async function createKpi(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_CREATE);
  if (denied) return denied;

  const parsed = createKpiSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  if (!(await projectInOrg(data.projectId, ctx.orgId))) return { error: "Project not found" };

  const maxSort = await prisma.kpi.aggregate({
    where: { orgId: ctx.orgId, projectId: data.projectId },
    _max: { sortOrder: true },
  });
  const created = await prisma.kpi.create({
    data: {
      orgId: ctx.orgId,
      projectId: data.projectId,
      name: data.name,
      description: data.description ?? null,
      unit: data.unit ?? "",
      targetValue: data.targetValue,
      currentValue: data.currentValue,
      direction: data.direction,
      sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
    },
    select: KPI_SELECT,
  });
  return { created: true, id: created.id, kpi: created };
}

// ── update_kpi ─────────────────────────────────────────────────────────
const updateKpiSchema = z.object({
  projectId: z.string().uuid(),
  kpiId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  unit: z.string().max(50).optional(),
  targetValue: z.number().optional(),
  currentValue: z.number().optional(),
  direction: z.nativeEnum(KpiDirection).optional(),
});

export async function updateKpi(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_UPDATE);
  if (denied) return denied;

  const parsed = updateKpiSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const existing = await prisma.kpi.findFirst({
    where: { id: data.kpiId, orgId: ctx.orgId, projectId: data.projectId },
    select: { id: true },
  });
  if (!existing) return { error: "KPI not found" };

  const updated = await prisma.kpi.update({
    where: { id: existing.id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.unit !== undefined && { unit: data.unit }),
      ...(data.targetValue !== undefined && { targetValue: data.targetValue }),
      ...(data.currentValue !== undefined && { currentValue: data.currentValue }),
      ...(data.direction !== undefined && { direction: data.direction }),
    },
    select: KPI_SELECT,
  });
  return { updated: true, id: updated.id, kpi: updated };
}
