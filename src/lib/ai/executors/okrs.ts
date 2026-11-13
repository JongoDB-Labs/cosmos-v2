import { prisma } from "@/lib/db/client";
import { ObjectiveStatus, KeyResultStatus, RagStatus } from "@prisma/client";
import { z } from "zod";
import { Permission } from "@/lib/rbac/permissions";
import { measureKeyResult, rollUpObjective } from "@/lib/okr/progress";
// Persists an objective's progress by the same rule the routes and the board use.
import { recomputeObjectiveProgress } from "@/lib/okr/rollup.server";
import { isOverdue, objectiveHealth } from "@/lib/okr/health";
import {
  createObjectiveDependency,
  dependenciesOf,
  deleteObjectiveDependency,
  type DependsOnSummary,
} from "@/lib/okr/dependencies.server";
import { ProblemError } from "@/lib/openapi/problem";
import { assertPermission, assertProjectRead, loadAuthContext, type ToolContext } from "./_ctx";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";

/**
 * OKR executors — objectives, key results, check-ins, KR↔work-item links. Every
 * query is org-scoped: objectives carry `orgId`; a key result is scoped through
 * its parent objective's `orgId`. Mirrors the routes under
 * `api/v1/orgs/[orgId]/projects/[projectId]/objectives|key-results/…`.
 */

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

// The old `projectInOrg` helper asked whether a project EXISTS in the org, which is
// true of one the caller may not open — a project with `teamScopedAccess` is
// restricted to its members. Replaced by `assertProjectRead`, which forwards to
// the same `requireProjectRead` the HTTP routes use. See _ctx.ts.

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

  // `projectId` is OPTIONAL here, so BOTH paths need bounding.
  //
  // The comment this replaces said "Objectives with no project are not project-scoped data
  // and nothing narrows them" and used that to justify gating only the named path. There is
  // no such row: `Objective.projectId` is `String`, NOT `String?` (schema.prisma) — every
  // objective belongs to exactly one project. So the omission path was not "org-level
  // data", it was every project's OKRs, unnarrowed: titles, descriptions, owners, status,
  // progress, health, and each key result's current and target values, for team-scoped
  // projects the actor is not a member of. OKR_READ is MEMBER-held.
  //
  // Named path: gate it (folds the OKR_READ ABAC rule for that project).
  // Omission path: scope to the actor's readable projects, the same shape `listFeedback`,
  // `listMeetings` and `queryWorkItems` use. `getReadableProjectIds` is AuthContext-based,
  // so a project-scoped API key's ceiling and an agent policy's allowlist both bind here;
  // note it folds ABAC ITEM_READ denies rather than OKR_READ ones, which is the same
  // asymmetry its siblings carry — it narrows by team scope and key scope either way.
  let readable: string[] | null = null;
  if (projectId) {
    const outOfScope = await assertProjectRead(ctx, projectId, "OKR_READ");
    if (outOfScope) return outOfScope;
  } else {
    const auth = await loadAuthContext(ctx);
    if (!auth) return { error: "Insufficient permissions" };
    readable = await getReadableProjectIds(auth);
    // An EMPTY readable set means NOTHING, never "no filter" — the inversion that makes
    // the most restricted actor the least restricted one.
    if (readable.length === 0) return { count: 0, objectives: [] };
  }

  const objectives = await prisma.objective.findMany({
    where: {
      orgId: ctx.orgId,
      ...(projectId ? { projectId } : { projectId: { in: readable! } }),
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    take: Math.min(limit ?? 50, 100),
    include: {
      keyResults: {
        orderBy: { sortOrder: "asc" },
        include: { links: { select: { workItem: { select: { id: true, completedAt: true } } } } },
      },
      // The objective's own linked delivery, which speaks for an objective
      // with no key results — as on the OKR board.
      links: { select: { workItem: { select: { completedAt: true } } } },
    },
  });

  // The same rule the objectives GET route and the OKR board use
  // (lib/okr/progress): a KR with linked tickets auto-tracks (current value =
  // # of linked items done, target = # linked unless one was set); objective
  // progress rolls up from the KRs, or from its own links when it has none;
  // health is progress vs. time toward the target date.
  // What each objective needs first, as on the board: only those the actor can read.
  const auth = await loadAuthContext(ctx);
  const dependsOn: Map<string, DependsOnSummary[]> = auth ? await dependenciesOf(auth, objectives.map((o) => o.id)) : new Map();
  const shaped = objectives.map((o) => {
    const keyResults = o.keyResults.map((kr) => {
      const m = measureKeyResult(kr, kr.links.map((l) => l.workItem));
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
        currentValue: m.currentValue,
        targetValue: m.targetValue,
        unit: kr.unit,
        autoTracked: m.autoTracked,
        targetFromLinks: m.targetFromLinks,
        linkedTotal: m.linkedTotal,
        linkedDone: m.linkedDone,
        progress: m.progress,
        createdAt: kr.createdAt,
        updatedAt: kr.updatedAt,
      };
    });
    const { progress } = rollUpObjective(keyResults, o.links.map((l) => l.workItem));
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
      overdue: isOverdue(progress, o.targetDate, o.status),
      dependsOn: (dependsOn.get(o.id) ?? []).map((d) => ({ id: d.id, projectId: d.projectId, title: d.title, health: d.health, overdue: d.overdue })),
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

  const outOfScope = await assertProjectRead(ctx, data.projectId, "OKR_CREATE");
  if (outOfScope) return outOfScope;

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
    select: { id: true, projectId: true },
  });
  if (!existing) return { error: "Objective not found" };

  // The org check above only proves the row EXISTS. Its project may be
  // team-scoped and closed to this actor — see _ctx.ts. Same message either
  // way, so a refusal never confirms the row is real.
  const outOfScope = await assertProjectRead(ctx, existing.projectId, "OKR_UPDATE");
  if (outOfScope) return { error: "Objective not found" };

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
    select: { id: true, projectId: true },
  });
  if (!existing) return { error: "Objective not found" };

  // The org check above only proves the row EXISTS. Its project may be
  // team-scoped and closed to this actor — see _ctx.ts. Same message either
  // way, so a refusal never confirms the row is real.
  const outOfScope = await assertProjectRead(ctx, existing.projectId, "OKR_DELETE");
  if (outOfScope) return { error: "Objective not found" };

  await prisma.objective.delete({ where: { id: existing.id } });
  return { deleted: true, id: existing.id };
}

// ── add/remove_objective_dependency ─────────────────────────────────────────
// The same service as the REST route (lib/okr/dependencies.server): same org,
// a project the actor can see and read OKRs in, never itself, never a loop.
const dependencySchema = z.object({ objectiveId: z.string().uuid(), dependsOnId: z.string().uuid() });

/** The objective that will wait, if the actor may edit it; else the refusal. */
async function editableObjective(ctx: ToolContext, objectiveId: string) {
  const existing = await prisma.objective.findFirst({
    where: { id: objectiveId, orgId: ctx.orgId },
    select: { id: true, projectId: true },
  });
  // Same message for a missing row and a closed project, as update_objective.
  if (!existing || (await assertProjectRead(ctx, existing.projectId, "OKR_UPDATE"))) return null;
  return existing;
}

export async function addObjectiveDependency(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_UPDATE);
  if (denied) return denied;
  const parsed = dependencySchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { objectiveId, dependsOnId } = parsed.data;

  if (!(await editableObjective(ctx, objectiveId))) return { error: "Objective not found" };
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };
  try {
    const dependency = await createObjectiveDependency(auth, objectiveId, dependsOnId);
    return { added: true, id: dependency.id, dependency };
  } catch (e) {
    if (e instanceof ProblemError) return { error: e.message };
    throw e;
  }
}

export async function removeObjectiveDependency(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.OKR_UPDATE);
  if (denied) return denied;
  const parsed = dependencySchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { objectiveId, dependsOnId } = parsed.data;

  if (!(await editableObjective(ctx, objectiveId))) return { error: "Objective not found" };
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };
  if (!(await deleteObjectiveDependency(auth, objectiveId, dependsOnId))) {
    return { error: "That objective doesn't depend on the other one." };
  }
  return { removed: true, objectiveId, dependsOnId };
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
    select: { id: true, projectId: true },
  });
  if (!objective) return { error: "Objective not found" };

  // The objective's project decides. Adding a key result to an objective on a
  // project you cannot open writes into that project's plan.
  const outOfScope = await assertProjectRead(ctx, objective.projectId, "OKR_CREATE");
  if (outOfScope) return { error: "Objective not found" };

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
    select: { id: true, objectiveId: true, objective: { select: { projectId: true } } },
  });
  if (!existing) return { error: "Key result not found" };
  // A key result inherits its scope from the objective's project, which may be
  // team-scoped. Same message as a genuine miss, so a refusal never confirms
  // the key result is real.
  const outOfScope = await assertProjectRead(ctx, existing.objective.projectId, "OKR_UPDATE");
  if (outOfScope) return { error: "Key result not found" };


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
    select: { id: true, objectiveId: true, objective: { select: { projectId: true } } },
  });
  if (!kr) return { error: "Key result not found" };
  // A key result inherits its scope from the objective's project, which may be
  // team-scoped. Same message as a genuine miss, so a refusal never confirms
  // the key result is real.
  const outOfScope = await assertProjectRead(ctx, kr.objective.projectId, "OKR_UPDATE");
  if (outOfScope) return { error: "Key result not found" };


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
  // A key result inherits its scope from the objective's project, which may be
  // team-scoped. Same message as a genuine miss, so a refusal never confirms
  // the key result is real.
  const outOfScope = await assertProjectRead(ctx, kr.objective.projectId, "OKR_UPDATE");
  if (outOfScope) return { error: "Key result not found" };


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
