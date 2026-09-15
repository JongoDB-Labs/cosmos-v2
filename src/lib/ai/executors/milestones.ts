import { prisma } from "@/lib/db/client";
import { MilestoneStatus } from "@prisma/client";
import { z } from "zod";
import { Permission } from "@/lib/rbac/permissions";
import { assertPermission, assertProjectManage, assertProjectRead, type ToolContext } from "./_ctx";

/**
 * Milestone executors — project delivery milestones. Every query is org+project
 * scoped. Mirrors `api/v1/orgs/[orgId]/projects/[projectId]/milestones/…`.
 */

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

// The old `projectInOrg` helper asked whether a project EXISTS in the org, which is
// true of one the caller may not open — a project with `teamScopedAccess` is
// restricted to its members. Replaced by `assertProjectRead`, which forwards to
// the same `requireProjectRead` the HTTP routes use. See _ctx.ts.

const MILESTONE_SELECT = {
  id: true, projectId: true, ownerId: true, intervalId: true, status: true, dueDate: true,
  autoStatus: true, completedAt: true, scheduleEscalate: true,
  actualDate: true, sortOrder: true, title: true, createdAt: true, updatedAt: true,
} as const;

// ── list_milestones ─────────────────────────────────────────────────────────
const listSchema = z.object({
  projectId: z.string().uuid(),
  limit: z.number().int().positive().optional(),
});

export async function listMilestones(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_READ);
  if (denied) return denied;

  const parsed = listSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, limit } = parsed.data;

  const outOfScope = await assertProjectRead(ctx, projectId, "PROJECT_READ");
  if (outOfScope) return outOfScope;

  const milestones = await prisma.milestone.findMany({
    where: { orgId: ctx.orgId, projectId },
    orderBy: [{ sortOrder: "asc" }, { dueDate: "asc" }],
    take: Math.min(limit ?? 50, 100),
    select: MILESTONE_SELECT,
  });
  return { count: milestones.length, milestones };
}

// ── create_milestone ─────────────────────────────────────────────────────────
const createSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  dueDate: z.string().datetime(),
  ownerId: z.string().uuid().nullish(),
  autoStatus: z.boolean().optional(),
});

export async function createMilestone(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_UPDATE);
  if (denied) return denied;

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const denied2 = await assertProjectManage(ctx, data.projectId, Permission.PROJECT_UPDATE);
  if (denied2) return denied2;

  const maxSort = await prisma.milestone.aggregate({
    where: { orgId: ctx.orgId, projectId: data.projectId },
    _max: { sortOrder: true },
  });
  const created = await prisma.milestone.create({
    data: {
      orgId: ctx.orgId,
      projectId: data.projectId,
      title: data.title,
      description: data.description ?? null,
      dueDate: new Date(data.dueDate),
      ownerId: data.ownerId ?? null,
      autoStatus: data.autoStatus ?? true,
      sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
    },
    select: MILESTONE_SELECT,
  });
  return { created: true, id: created.id, milestone: created };
}

// ── update_milestone ─────────────────────────────────────────────────────────
const updateSchema = z.object({
  projectId: z.string().uuid(),
  milestoneId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  dueDate: z.string().datetime().optional(),
  status: z.nativeEnum(MilestoneStatus).optional(),
  ownerId: z.string().uuid().nullish(),
  autoStatus: z.boolean().optional(),
});

export async function updateMilestone(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_UPDATE);
  if (denied) return denied;

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const existing = await prisma.milestone.findFirst({
    where: { id: data.milestoneId, orgId: ctx.orgId, projectId: data.projectId },
    select: { id: true, projectId: true },
  });
  if (!existing) return { error: "Milestone not found" };

  // The org check above only proves the row EXISTS. Its project may be
  // team-scoped and closed to this actor — see _ctx.ts. Same message either
  // way, so a refusal never confirms the row is real.
  const denied2 = await assertProjectManage(ctx, existing.projectId, Permission.PROJECT_UPDATE);
  if (denied2) return denied2;

  const updated = await prisma.milestone.update({
    where: { id: existing.id },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.dueDate !== undefined && { dueDate: new Date(data.dueDate) }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.ownerId !== undefined && { ownerId: data.ownerId }),
      ...(data.autoStatus !== undefined && { autoStatus: data.autoStatus }),
    },
    select: MILESTONE_SELECT,
  });
  return { updated: true, id: updated.id, milestone: updated };
}

// ── delete_milestone ─────────────────────────────────────────────────────────
const deleteSchema = z.object({
  projectId: z.string().uuid(),
  milestoneId: z.string().uuid(),
});

export async function deleteMilestone(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_UPDATE);
  if (denied) return denied;

  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const existing = await prisma.milestone.findFirst({
    where: { id: data.milestoneId, orgId: ctx.orgId, projectId: data.projectId },
    select: { id: true, projectId: true },
  });
  if (!existing) return { error: "Milestone not found" };

  // The org check above only proves the row EXISTS. Its project may be
  // team-scoped and closed to this actor — see _ctx.ts. Same message either
  // way, so a refusal never confirms the row is real.
  const denied2 = await assertProjectManage(ctx, existing.projectId, Permission.PROJECT_UPDATE);
  if (denied2) return denied2;

  await prisma.milestone.delete({ where: { id: existing.id } });
  return { deleted: true, id: existing.id };
}
