import { prisma } from "@/lib/db/client";
import { ObjectiveStatus, KeyResultStatus, RagStatus } from "@prisma/client";
import { z } from "zod";
import { Permission } from "@/lib/rbac/permissions";
import { krProgressPercent, krFraction } from "@/lib/okr/progress";
import { objectiveHealth } from "@/lib/okr/health";
import { assertPermission, type ToolContext } from "./_ctx";

/**
 * OKR executors — objectives, key results, check-ins, KR↔work-item links. Every
 * query is org-scoped: objectives carry `orgId`; a key result is scoped through
 * its parent objective's `orgId`. Mirrors the routes under
 * `api/v1/orgs/[orgId]/projects/[projectId]/objectives|key-results/…`.
 */

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

/** Confirm a project is in the actor's org (mirrors every OKR route's guard). */
async function projectInOrg(projectId: string, orgId: string): Promise<boolean> {
  const project = await prisma.project.findFirst({ where: { id: projectId, orgId }, select: { id: true } });
  return Boolean(project);
}

/** Recompute + persist an objective's progress from all its key results (mirrors the routes). */
async function recomputeObjectiveProgress(objectiveId: string): Promise<void> {
  const siblings = await prisma.keyResult.findMany({
    where: { objectiveId },
    select: { startValue: true, currentValue: true, targetValue: true, lowerIsBetter: true },
  });
  const progress =
    siblings.length === 0
      ? 0
      : Math.round(
          (siblings.reduce(
            (sum, s) => sum + krFraction(s.startValue, s.currentValue, s.targetValue, s.lowerIsBetter),
            0,
          ) /
            siblings.length) *
            100,
        );
  await prisma.objective.update({ where: { id: objectiveId }, data: { progress } });
}

// ── list_objectives ─────────────────────────────────────────────────────────
const listObjectivesSchema = z.object({
  projectId: z.string().uuid().optional(),
  limit: z.number().int().positive().optional(),
});

export async function listObjectives(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_READ);
  if (denied) return denied;

  const parsed = listObjectivesSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, limit } = parsed.data;

  if (projectId && !(await projectInOrg(projectId, ctx.orgId))) return { error: "Project not found" };

  const objectives = await prisma.objective.findMany({
    where: { orgId: ctx.orgId, ...(projectId && { projectId }) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    take: Math.min(limit ?? 50, 100),
    include: {
      keyResults: {
        orderBy: { sortOrder: "asc" },
        include: { links: { select: { workItem: { select: { id: true, completedAt: true } } } } },
      },
    },
  });

  // Same roll-up the objectives GET route computes: a KR with linked tickets
  // auto-tracks (current value = # of linked items done); objective progress is
  // the mean KR progress; health is progress vs. time toward the target date.
  const shaped = objectives.map((o) => {
    const keyResults = o.keyResults.map((kr) => {
      const linkedTotal = kr.links.length;
      const linkedDone = kr.links.filter((l) => l.workItem.completedAt != null).length;
      const currentValue = linkedTotal > 0 ? linkedDone : kr.currentValue;
      return {
        id: kr.id,
        objectiveId: kr.objectiveId,
        ownerId: kr.ownerId,
        status: kr.status,
        rag: kr.rag,
        confidence: kr.confidence,
        lowerIsBetter: kr.lowerIsBetter,
        sortOrder: kr.sortOrder,
        title: kr.title,
        startValue: kr.startValue,
        currentValue,
        targetValue: kr.targetValue,
        unit: kr.unit,
        autoTracked: linkedTotal > 0,
        linkedTotal,
        linkedDone,
        createdAt: kr.createdAt,
        updatedAt: kr.updatedAt,
      };
    });
    const progress =
      keyResults.length === 0
        ? 0
        : Math.round(
            keyResults.reduce(
              (sum, kr) => sum + krProgressPercent(kr.startValue, kr.currentValue, kr.targetValue, kr.lowerIsBetter),
              0,
            ) / keyResults.length,
          );
    return {
      id: o.id,
      projectId: o.projectId,
      ownerId: o.ownerId,
      parentId: o.parentId,
      status: o.status,
      title: o.title,
      description: o.description,
      targetDate: o.targetDate,
      sortOrder: o.sortOrder,
      progress,
      health: objectiveHealth(progress, o.targetDate, o.status, o.createdAt),
      keyResults,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    };
  });

  return { count: shaped.length, objectives: shaped };
}

// ── create_objective ─────────────────────────────────────────────────────────
const createObjectiveSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  targetDate: z.string().datetime().nullish(),
});

export async function createObjective(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_CREATE);
  if (denied) return denied;

  const parsed = createObjectiveSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  if (!(await projectInOrg(data.projectId, ctx.orgId))) return { error: "Project not found" };

  const last = await prisma.objective.findFirst({
    where: { orgId: ctx.orgId, projectId: data.projectId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const created = await prisma.objective.create({
    data: {
      orgId: ctx.orgId,
      projectId: data.projectId,
      title: data.title,
      description: data.description ?? null,
      targetDate: data.targetDate ? new Date(data.targetDate) : null,
      status: ObjectiveStatus.ACTIVE,
      progress: 0,
      sortOrder: last ? last.sortOrder + 1 : 0,
    },
    select: {
      id: true, projectId: true, ownerId: true, parentId: true, status: true,
      title: true, targetDate: true, progress: true, sortOrder: true, createdAt: true, updatedAt: true,
    },
  });
  return { created: true, id: created.id, objective: created };
}

// ── update_objective ─────────────────────────────────────────────────────────
const updateObjectiveSchema = z.object({
  objectiveId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  targetDate: z.string().datetime().nullable().optional(),
  status: z.nativeEnum(ObjectiveStatus).optional(),
});

export async function updateObjective(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_UPDATE);
  if (denied) return denied;

  const parsed = updateObjectiveSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const existing = await prisma.objective.findFirst({
    where: { id: data.objectiveId, orgId: ctx.orgId },
    select: { id: true },
  });
  if (!existing) return { error: "Objective not found" };

  const updated = await prisma.objective.update({
    where: { id: existing.id },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.targetDate !== undefined && { targetDate: data.targetDate ? new Date(data.targetDate) : null }),
    },
    select: {
      id: true, projectId: true, ownerId: true, parentId: true, status: true,
      title: true, targetDate: true, progress: true, sortOrder: true, createdAt: true, updatedAt: true,
    },
  });
  return { updated: true, id: updated.id, objective: updated };
}

// ── delete_objective ─────────────────────────────────────────────────────────
const deleteObjectiveSchema = z.object({ objectiveId: z.string().uuid() });

export async function deleteObjective(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_DELETE);
  if (denied) return denied;

  const parsed = deleteObjectiveSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);

  const existing = await prisma.objective.findFirst({
    where: { id: parsed.data.objectiveId, orgId: ctx.orgId },
    select: { id: true },
  });
  if (!existing) return { error: "Objective not found" };

  await prisma.objective.delete({ where: { id: existing.id } });
  return { deleted: true, id: existing.id };
}

// ── create_key_result ─────────────────────────────────────────────────────────
const createKrSchema = z.object({
  objectiveId: z.string().uuid(),
  title: z.string().min(1).max(200),
  startValue: z.number().default(0),
  currentValue: z.number().default(0),
  targetValue: z.number().default(100),
  unit: z.string().max(40).nullish(),
  lowerIsBetter: z.boolean().default(false),
});

export async function createKeyResult(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_CREATE);
  if (denied) return denied;

  const parsed = createKrSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const objective = await prisma.objective.findFirst({
    where: { id: data.objectiveId, orgId: ctx.orgId },
    select: { id: true },
  });
  if (!objective) return { error: "Objective not found" };

  const last = await prisma.keyResult.findFirst({
    where: { objectiveId: data.objectiveId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const created = await prisma.keyResult.create({
    data: {
      objectiveId: data.objectiveId,
      title: data.title,
      startValue: data.startValue,
      currentValue: data.currentValue,
      targetValue: data.targetValue,
      unit: data.unit ?? "",
      lowerIsBetter: data.lowerIsBetter,
      status: KeyResultStatus.IN_PROGRESS,
      sortOrder: last ? last.sortOrder + 1 : 0,
    },
    select: {
      id: true, objectiveId: true, ownerId: true, status: true, rag: true, confidence: true,
      lowerIsBetter: true, sortOrder: true, title: true, startValue: true, currentValue: true,
      targetValue: true, unit: true, createdAt: true, updatedAt: true,
    },
  });
  await recomputeObjectiveProgress(data.objectiveId);
  return { created: true, id: created.id, keyResult: created };
}

// ── update_key_result ─────────────────────────────────────────────────────────
const updateKrSchema = z.object({
  keyResultId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  currentValue: z.number().optional(),
  targetValue: z.number().optional(),
  startValue: z.number().optional(),
  unit: z.string().max(40).optional(),
  status: z.nativeEnum(KeyResultStatus).optional(),
});

export async function updateKeyResult(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_UPDATE);
  if (denied) return denied;

  const parsed = updateKrSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const existing = await prisma.keyResult.findFirst({
    where: { id: data.keyResultId, objective: { orgId: ctx.orgId } },
    select: { id: true, objectiveId: true },
  });
  if (!existing) return { error: "Key result not found" };

  const updated = await prisma.keyResult.update({
    where: { id: existing.id },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.currentValue !== undefined && { currentValue: data.currentValue }),
      ...(data.targetValue !== undefined && { targetValue: data.targetValue }),
      ...(data.startValue !== undefined && { startValue: data.startValue }),
      ...(data.unit !== undefined && { unit: data.unit }),
      ...(data.status !== undefined && { status: data.status }),
    },
    select: {
      id: true, objectiveId: true, ownerId: true, status: true, rag: true, confidence: true,
      lowerIsBetter: true, sortOrder: true, title: true, startValue: true, currentValue: true,
      targetValue: true, unit: true, createdAt: true, updatedAt: true,
    },
  });
  await recomputeObjectiveProgress(existing.objectiveId);
  return { updated: true, id: updated.id, keyResult: updated };
}

// ── add_kr_checkin ─────────────────────────────────────────────────────────
// The check-in schema requires a stoplight (KeyResultCheckin.rag is non-null).
// The brief lists `rag` as optional, so when omitted we DERIVE it from confidence
// (≥70 GREEN, ≥40 YELLOW, else RED) — the same "needs attention" ladder the route
// maps into KeyResultStatus. `confidence` defaults to the schema default (50).
const RAG_TO_STATUS: Record<RagStatus, KeyResultStatus> = {
  GREEN: KeyResultStatus.ON_TRACK,
  YELLOW: KeyResultStatus.AT_RISK,
  RED: KeyResultStatus.AT_RISK,
};

const addCheckinSchema = z.object({
  keyResultId: z.string().uuid(),
  value: z.number(),
  confidence: z.number().int().min(0).max(100).default(50),
  rag: z.nativeEnum(RagStatus).optional(),
  note: z.string().max(2000).nullish(),
});

function ragFromConfidence(confidence: number): RagStatus {
  if (confidence >= 70) return RagStatus.GREEN;
  if (confidence >= 40) return RagStatus.YELLOW;
  return RagStatus.RED;
}

export async function addKrCheckin(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_UPDATE);
  if (denied) return denied;

  const parsed = addCheckinSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const kr = await prisma.keyResult.findFirst({
    where: { id: data.keyResultId, objective: { orgId: ctx.orgId } },
    select: { id: true, objectiveId: true },
  });
  if (!kr) return { error: "Key result not found" };

  const rag = data.rag ?? ragFromConfidence(data.confidence);

  const checkin = await prisma.keyResultCheckin.create({
    data: {
      keyResultId: kr.id,
      value: data.value,
      confidence: data.confidence,
      rag,
      note: data.note ?? null,
      checkedInById: ctx.userId,
    },
    select: { id: true, keyResultId: true, confidence: true, rag: true, checkedInById: true, createdAt: true },
  });

  // Fold into the KR's live snapshot (mirrors the check-ins route), then re-roll
  // the parent objective's progress.
  await prisma.keyResult.update({
    where: { id: kr.id },
    data: { currentValue: data.value, confidence: data.confidence, rag, status: RAG_TO_STATUS[rag] },
  });
  await recomputeObjectiveProgress(kr.objectiveId);

  return { created: true, id: checkin.id, checkin };
}

// ── link_key_result_item ─────────────────────────────────────────────────────
const linkKrItemSchema = z.object({
  keyResultId: z.string().uuid(),
  workItemId: z.string().uuid(),
});

export async function linkKeyResultItem(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_UPDATE);
  if (denied) return denied;

  const parsed = linkKrItemSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const kr = await prisma.keyResult.findFirst({
    where: { id: data.keyResultId, objective: { orgId: ctx.orgId } },
    select: { id: true, objective: { select: { projectId: true } } },
  });
  if (!kr) return { error: "Key result not found" };

  // The work item must be in the SAME org + project as the KR's objective (mirrors the route).
  const item = await prisma.workItem.findFirst({
    where: { id: data.workItemId, orgId: ctx.orgId, projectId: kr.objective.projectId },
    select: { id: true },
  });
  if (!item) return { error: "Work item not in this project" };

  const link = await prisma.keyResultLink.upsert({
    where: { keyResultId_workItemId: { keyResultId: kr.id, workItemId: data.workItemId } },
    create: { orgId: ctx.orgId, keyResultId: kr.id, workItemId: data.workItemId },
    update: {},
    select: { id: true, keyResultId: true, workItemId: true, createdAt: true },
  });
  return { created: true, id: link.id, link };
}
