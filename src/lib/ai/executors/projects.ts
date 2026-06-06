import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { CycleKind, type Prisma } from "@prisma/client";
import { z } from "zod";
import { assertPermission, type ToolContext } from "./_ctx";

const listProjectsSchema = z.object({
  includeArchived: z.boolean().optional(),
});

const listCyclesSchema = z.object({
  projectId: z.string().uuid(),
  status: z.enum(["PLANNED", "ACTIVE", "COMPLETED"]).optional(),
  limit: z.number().int().positive().optional(),
});

const createCycleSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(100),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
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

  return { count: projects.length, projects };
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
      startDate: new Date(data.startDate),
      endDate: new Date(data.endDate),
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
