import { prisma } from "@/lib/db/client";
import {
  RiskStatus,
  BlockerType,
  BlockerStatus,
  DeliverableStatus,
  ChangeRequestStatus,
} from "@prisma/client";
import { z } from "zod";
import { Permission } from "@/lib/rbac/permissions";
import { computeRiskScore, riskLevelFromScore } from "@/lib/pm/risk";
import { logPmActivity, logPmFieldChanges } from "@/lib/pm/activity-log";
import { resolvePmSubject, isPmSubjectType } from "@/lib/pm/subjects";
import { assertPermission, type ToolContext } from "./_ctx";

/**
 * Confirm a project exists inside the actor's org (mirrors the
 * `prisma.project.findFirst({ where: { id, orgId } })` guard every PM route
 * runs after auth). Returns true when the project is in-org.
 */
async function projectInOrg(projectId: string, orgId: string): Promise<boolean> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId },
    select: { id: true },
  });
  return Boolean(project);
}

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

// ── list_risks ────────────────────────────────────────────────────────────
const listRisksSchema = z.object({
  projectId: z.string().uuid(),
  status: z.nativeEnum(RiskStatus).optional(),
  limit: z.number().int().positive().optional(),
});

export async function listRisks(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ANALYTICS_READ);
  if (denied) return denied;

  const parsed = listRisksSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, status, limit } = parsed.data;

  if (!(await projectInOrg(projectId, ctx.orgId))) return { error: "Project not found" };

  const risks = await prisma.risk.findMany({
    where: { orgId: ctx.orgId, projectId, ...(status && { status }) },
    orderBy: [{ score: "desc" }, { createdAt: "desc" }],
    take: Math.min(limit ?? 50, 100),
    select: {
      id: true,
      code: true,
      title: true,
      level: true,
      score: true,
      status: true,
      owner: true,
    },
  });
  return { count: risks.length, risks };
}

// ── create_risk ───────────────────────────────────────────────────────────
const createRiskSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  likelihood: z.number().int().min(1).max(5).default(1),
  impact: z.number().int().min(1).max(5).default(1),
  category: z.string().max(80).nullish(),
  owner: z.string().max(120).nullish(),
  mitigation: z.string().nullish(),
});

/** Next R-NNN code for the org (codes are unique per org) — mirrors the route. */
async function nextRiskCode(orgId: string): Promise<string> {
  const rows = await prisma.risk.findMany({ where: { orgId }, select: { code: true } });
  const max = rows.reduce((mx, r) => {
    const m = r.code.match(/^R-(\d+)$/);
    return m ? Math.max(mx, Number(m[1])) : mx;
  }, 0);
  return `R-${String(max + 1).padStart(3, "0")}`;
}

export async function createRisk(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_UPDATE);
  if (denied) return denied;

  const parsed = createRiskSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  if (!(await projectInOrg(data.projectId, ctx.orgId))) return { error: "Project not found" };

  const score = computeRiskScore(data.likelihood, data.impact);
  const created = await prisma.risk.create({
    data: {
      orgId: ctx.orgId,
      projectId: data.projectId,
      code: await nextRiskCode(ctx.orgId),
      title: data.title,
      description: data.description ?? null,
      category: data.category ?? null,
      likelihood: data.likelihood,
      impact: data.impact,
      score,
      level: riskLevelFromScore(score),
      owner: data.owner ?? null,
      mitigation: data.mitigation ?? null,
      dateIdentified: new Date(),
    },
    select: {
      id: true,
      code: true,
      title: true,
      level: true,
      score: true,
      status: true,
      owner: true,
    },
  });

  // Seed the activity log with a "created" event (best-effort).
  await logPmActivity({
    orgId: ctx.orgId,
    subjectType: "risk",
    subjectId: created.id,
    userId: ctx.userId,
    action: "created",
  });

  return { created: true, risk: created };
}

// ── update_risk ───────────────────────────────────────────────────────────
const updateRiskSchema = z.object({
  projectId: z.string().uuid(),
  riskId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  likelihood: z.number().int().min(1).max(5).optional(),
  impact: z.number().int().min(1).max(5).optional(),
  category: z.string().max(80).nullish(),
  owner: z.string().max(120).nullish(),
  mitigation: z.string().nullish(),
  contingency: z.string().nullish(),
  status: z.nativeEnum(RiskStatus).optional(),
  escalate: z.boolean().optional(),
});

export async function updateRisk(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_UPDATE);
  if (denied) return denied;

  const parsed = updateRiskSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const existing = await prisma.risk.findFirst({
    where: { id: data.riskId, orgId: ctx.orgId, projectId: data.projectId },
  });
  if (!existing) return { error: "Risk not found" };

  // Recompute score + level when either driver changes (matches the route).
  const likelihood = data.likelihood ?? existing.likelihood;
  const impact = data.impact ?? existing.impact;
  const recompute = data.likelihood !== undefined || data.impact !== undefined;
  const score = recompute ? computeRiskScore(likelihood, impact) : existing.score;

  const updated = await prisma.risk.update({
    where: { id: existing.id },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.category !== undefined && { category: data.category }),
      ...(data.likelihood !== undefined && { likelihood: data.likelihood }),
      ...(data.impact !== undefined && { impact: data.impact }),
      ...(recompute && { score, level: riskLevelFromScore(score) }),
      ...(data.owner !== undefined && { owner: data.owner }),
      ...(data.mitigation !== undefined && { mitigation: data.mitigation }),
      ...(data.contingency !== undefined && { contingency: data.contingency }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.escalate !== undefined && { escalate: data.escalate }),
    },
    select: {
      id: true,
      code: true,
      title: true,
      level: true,
      score: true,
      status: true,
      owner: true,
    },
  });

  // Audit field changes (best-effort), same label-keyed maps as the route.
  await logPmFieldChanges(
    { orgId: ctx.orgId, subjectType: "risk", subjectId: existing.id, userId: ctx.userId },
    {
      title: existing.title,
      status: existing.status,
      likelihood: existing.likelihood,
      impact: existing.impact,
      owner: existing.owner,
      mitigation: existing.mitigation,
      category: existing.category,
      escalate: existing.escalate,
    },
    {
      title: updated.title,
      status: updated.status,
      likelihood,
      impact,
      owner: updated.owner,
      mitigation: data.mitigation !== undefined ? data.mitigation : existing.mitigation,
      category: data.category !== undefined ? data.category : existing.category,
      escalate: data.escalate !== undefined ? data.escalate : existing.escalate,
    },
  );

  return { updated: true, risk: updated };
}

// ── add_pm_comment ────────────────────────────────────────────────────────
const addPmCommentSchema = z.object({
  projectId: z.string().uuid(),
  subjectType: z.string(),
  subjectId: z.string().uuid(),
  content: z.string().min(1).max(10_000),
});

export async function addPmComment(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.COMMENT_CREATE);
  if (denied) return denied;

  const parsed = addPmCommentSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  if (!isPmSubjectType(data.subjectType)) {
    return { error: `Invalid subjectType: ${data.subjectType}` };
  }

  const subject = await resolvePmSubject(
    data.subjectType,
    data.subjectId,
    ctx.orgId,
    data.projectId,
  );
  if (!subject) return { error: "Subject not found" };

  const comment = await prisma.comment.create({
    data: {
      orgId: ctx.orgId,
      subjectType: data.subjectType,
      subjectId: data.subjectId,
      authorId: ctx.userId,
      content: data.content,
    },
  });
  await logPmActivity({
    orgId: ctx.orgId,
    subjectType: data.subjectType,
    subjectId: data.subjectId,
    userId: ctx.userId,
    action: "commented",
  });

  return {
    created: true,
    id: comment.id,
    subjectType: data.subjectType,
    subjectId: data.subjectId,
    contentPreview: comment.content.slice(0, 200),
  };
}

// ── list_blockers ─────────────────────────────────────────────────────────
const listRegisterSchema = z.object({
  projectId: z.string().uuid(),
  status: z.string().max(40).optional(),
  limit: z.number().int().positive().optional(),
});

export async function listBlockers(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ANALYTICS_READ);
  if (denied) return denied;

  const parsed = listRegisterSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, status, limit } = parsed.data;

  if (!(await projectInOrg(projectId, ctx.orgId))) return { error: "Project not found" };

  const blockers = await prisma.blocker.findMany({
    where: {
      orgId: ctx.orgId,
      projectId,
      ...(status && { status: status as never }),
    },
    orderBy: { identifiedAt: "desc" },
    take: Math.min(limit ?? 50, 100),
    select: {
      id: true,
      code: true,
      title: true,
      type: true,
      status: true,
      owner: true,
    },
  });
  return { count: blockers.length, blockers };
}

// ── list_deliverables ─────────────────────────────────────────────────────
export async function listDeliverables(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ANALYTICS_READ);
  if (denied) return denied;

  const parsed = listRegisterSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, status, limit } = parsed.data;

  if (!(await projectInOrg(projectId, ctx.orgId))) return { error: "Project not found" };

  const deliverables = await prisma.deliverable.findMany({
    where: {
      orgId: ctx.orgId,
      projectId,
      ...(status && { status: status as never }),
    },
    orderBy: [{ baselineDue: "asc" }, { createdAt: "desc" }],
    take: Math.min(limit ?? 50, 100),
    select: {
      id: true,
      code: true,
      title: true,
      clin: true,
      status: true,
      owner: true,
      baselineDue: true,
    },
  });
  return { count: deliverables.length, deliverables };
}

// ── list_changes ──────────────────────────────────────────────────────────
export async function listChanges(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ANALYTICS_READ);
  if (denied) return denied;

  const parsed = listRegisterSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { projectId, status, limit } = parsed.data;

  if (!(await projectInOrg(projectId, ctx.orgId))) return { error: "Project not found" };

  const changes = await prisma.changeRequest.findMany({
    where: {
      orgId: ctx.orgId,
      projectId,
      ...(status && { status: status as never }),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit ?? 50, 100),
    select: {
      id: true,
      code: true,
      title: true,
      type: true,
      status: true,
      costImpact: true,
      scheduleDaysImpact: true,
    },
  });
  return { count: changes.length, changes };
}

// ── create_blocker / update_blocker ────────────────────────────────────────
const BLOCKER_SELECT = {
  id: true, code: true, title: true, type: true, status: true, owner: true, projectId: true,
  branchId: true, customerNotified: true, escalate: true, identifiedAt: true, resolvedAt: true,
  targetDate: true, classification: true, createdAt: true, updatedAt: true,
} as const;

/** Next BL-NNN code for the org (mirrors the blockers route). */
async function nextBlockerCode(orgId: string): Promise<string> {
  const rows = await prisma.blocker.findMany({ where: { orgId }, select: { code: true } });
  const max = rows.reduce((mx, b) => {
    const m = b.code.match(/^BL-(\d+)$/);
    return m ? Math.max(mx, Number(m[1])) : mx;
  }, 0);
  return `BL-${String(max + 1).padStart(3, "0")}`;
}

const createBlockerSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  type: z.nativeEnum(BlockerType).default(BlockerType.INTERNAL),
  owner: z.string().max(120).nullish(),
  whatUnblocks: z.string().nullish(),
  escalate: z.boolean().default(false),
});

export async function createBlocker(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_UPDATE);
  if (denied) return denied;

  const parsed = createBlockerSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  if (!(await projectInOrg(data.projectId, ctx.orgId))) return { error: "Project not found" };

  const created = await prisma.blocker.create({
    data: {
      orgId: ctx.orgId,
      projectId: data.projectId,
      code: await nextBlockerCode(ctx.orgId),
      title: data.title,
      description: data.description ?? null,
      type: data.type,
      owner: data.owner ?? null,
      whatUnblocks: data.whatUnblocks ?? null,
      escalate: data.escalate,
    },
    select: BLOCKER_SELECT,
  });
  await logPmActivity({
    orgId: ctx.orgId, subjectType: "blocker", subjectId: created.id, userId: ctx.userId, action: "created",
  });
  return { created: true, id: created.id, blocker: created };
}

const updateBlockerSchema = z.object({
  projectId: z.string().uuid(),
  blockerId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  type: z.nativeEnum(BlockerType).optional(),
  owner: z.string().max(120).nullish(),
  whatUnblocks: z.string().nullish(),
  status: z.nativeEnum(BlockerStatus).optional(),
  escalate: z.boolean().optional(),
});

export async function updateBlocker(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_UPDATE);
  if (denied) return denied;

  const parsed = updateBlockerSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const existing = await prisma.blocker.findFirst({
    where: { id: data.blockerId, orgId: ctx.orgId, projectId: data.projectId },
  });
  if (!existing) return { error: "Blocker not found" };

  const updated = await prisma.blocker.update({
    where: { id: existing.id },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.type !== undefined && { type: data.type }),
      ...(data.owner !== undefined && { owner: data.owner }),
      ...(data.whatUnblocks !== undefined && { whatUnblocks: data.whatUnblocks }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.escalate !== undefined && { escalate: data.escalate }),
    },
    select: BLOCKER_SELECT,
  });
  await logPmFieldChanges(
    { orgId: ctx.orgId, subjectType: "blocker", subjectId: existing.id, userId: ctx.userId },
    { title: existing.title, status: existing.status, type: existing.type, owner: existing.owner, whatUnblocks: existing.whatUnblocks, escalate: existing.escalate },
    { title: updated.title, status: updated.status, type: updated.type, owner: updated.owner, whatUnblocks: data.whatUnblocks !== undefined ? data.whatUnblocks : existing.whatUnblocks, escalate: updated.escalate },
  );
  return { updated: true, id: updated.id, blocker: updated };
}

// ── create_deliverable / update_deliverable ────────────────────────────────
const DELIVERABLE_SELECT = {
  id: true, code: true, title: true, clin: true, status: true, owner: true, projectId: true,
  baselineDue: true, actualSubmission: true, govAcceptance: true, escalate: true,
  revisionCycle: true, milestoneId: true, branchId: true, classification: true, createdAt: true, updatedAt: true,
} as const;

/** Next CDRL-ANNN code for the org (mirrors the deliverables route). */
async function nextDeliverableCode(orgId: string): Promise<string> {
  const rows = await prisma.deliverable.findMany({ where: { orgId }, select: { code: true } });
  const max = rows.reduce((mx, r) => {
    const m = r.code.match(/^CDRL-A(\d+)$/);
    return m ? Math.max(mx, Number(m[1])) : mx;
  }, 0);
  return `CDRL-A${String(max + 1).padStart(3, "0")}`;
}

const createDeliverableSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  clin: z.string().max(80).nullish(),
  owner: z.string().max(120).nullish(),
  baselineDue: z.string().datetime().nullish(),
  status: z.nativeEnum(DeliverableStatus).default(DeliverableStatus.NOT_STARTED),
});

export async function createDeliverable(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_UPDATE);
  if (denied) return denied;

  const parsed = createDeliverableSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  if (!(await projectInOrg(data.projectId, ctx.orgId))) return { error: "Project not found" };

  const created = await prisma.deliverable.create({
    data: {
      orgId: ctx.orgId,
      projectId: data.projectId,
      code: await nextDeliverableCode(ctx.orgId),
      title: data.title,
      description: data.description ?? null,
      clin: data.clin ?? null,
      owner: data.owner ?? null,
      baselineDue: data.baselineDue ? new Date(data.baselineDue) : null,
      status: data.status,
    },
    select: DELIVERABLE_SELECT,
  });
  await logPmActivity({
    orgId: ctx.orgId, subjectType: "deliverable", subjectId: created.id, userId: ctx.userId, action: "created",
  });
  return { created: true, id: created.id, deliverable: created };
}

const updateDeliverableSchema = z.object({
  projectId: z.string().uuid(),
  deliverableId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  clin: z.string().max(80).nullish(),
  owner: z.string().max(120).nullish(),
  baselineDue: z.string().datetime().nullish(),
  actualSubmission: z.string().datetime().nullish(),
  status: z.nativeEnum(DeliverableStatus).optional(),
  escalate: z.boolean().optional(),
});

export async function updateDeliverable(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_UPDATE);
  if (denied) return denied;

  const parsed = updateDeliverableSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const existing = await prisma.deliverable.findFirst({
    where: { id: data.deliverableId, orgId: ctx.orgId, projectId: data.projectId },
  });
  if (!existing) return { error: "Deliverable not found" };

  const updated = await prisma.deliverable.update({
    where: { id: existing.id },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.clin !== undefined && { clin: data.clin }),
      ...(data.owner !== undefined && { owner: data.owner }),
      ...(data.baselineDue !== undefined && { baselineDue: data.baselineDue ? new Date(data.baselineDue) : null }),
      ...(data.actualSubmission !== undefined && { actualSubmission: data.actualSubmission ? new Date(data.actualSubmission) : null }),
      ...(data.status !== undefined && { status: data.status }),
      ...(data.escalate !== undefined && { escalate: data.escalate }),
    },
    select: DELIVERABLE_SELECT,
  });
  await logPmFieldChanges(
    { orgId: ctx.orgId, subjectType: "deliverable", subjectId: existing.id, userId: ctx.userId },
    { title: existing.title, status: existing.status, clin: existing.clin, owner: existing.owner, escalate: existing.escalate },
    { title: updated.title, status: updated.status, clin: updated.clin, owner: updated.owner, escalate: updated.escalate },
  );
  return { updated: true, id: updated.id, deliverable: updated };
}

// ── create_change_request / update_change_request ──────────────────────────
const CHANGE_SELECT = {
  id: true, code: true, title: true, type: true, status: true, costImpact: true,
  scheduleDaysImpact: true, projectId: true, modRequired: true, decidedAt: true,
  implDate: true, submittedDate: true, branchId: true, classification: true, createdAt: true, updatedAt: true,
} as const;

/** Next CR-NNN code for the org (mirrors the changes route). */
async function nextChangeCode(orgId: string): Promise<string> {
  const rows = await prisma.changeRequest.findMany({ where: { orgId }, select: { code: true } });
  const max = rows.reduce((mx, r) => {
    const m = r.code.match(/^CR-(\d+)$/);
    return m ? Math.max(mx, Number(m[1])) : mx;
  }, 0);
  return `CR-${String(max + 1).padStart(3, "0")}`;
}

const createChangeSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  type: z.string().max(80).nullish(),
  costImpact: z.number().nullish(),
  scheduleDaysImpact: z.number().int().nullish(),
  status: z.nativeEnum(ChangeRequestStatus).default(ChangeRequestStatus.SUBMITTED),
});

export async function createChangeRequest(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_UPDATE);
  if (denied) return denied;

  const parsed = createChangeSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  if (!(await projectInOrg(data.projectId, ctx.orgId))) return { error: "Project not found" };

  const created = await prisma.changeRequest.create({
    data: {
      orgId: ctx.orgId,
      projectId: data.projectId,
      code: await nextChangeCode(ctx.orgId),
      title: data.title,
      description: data.description ?? null,
      type: data.type ?? null,
      costImpact: data.costImpact ?? null,
      scheduleDaysImpact: data.scheduleDaysImpact ?? null,
      status: data.status,
    },
    select: CHANGE_SELECT,
  });
  await logPmActivity({
    orgId: ctx.orgId, subjectType: "change", subjectId: created.id, userId: ctx.userId, action: "created",
  });
  return { created: true, id: created.id, changeRequest: created };
}

const updateChangeSchema = z.object({
  projectId: z.string().uuid(),
  changeId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  type: z.string().max(80).nullish(),
  costImpact: z.number().nullish(),
  scheduleDaysImpact: z.number().int().nullish(),
  status: z.nativeEnum(ChangeRequestStatus).optional(),
});

export async function updateChangeRequest(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.PROJECT_UPDATE);
  if (denied) return denied;

  const parsed = updateChangeSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const existing = await prisma.changeRequest.findFirst({
    where: { id: data.changeId, orgId: ctx.orgId, projectId: data.projectId },
  });
  if (!existing) return { error: "Change request not found" };

  const updated = await prisma.changeRequest.update({
    where: { id: existing.id },
    data: {
      ...(data.title !== undefined && { title: data.title }),
      ...(data.description !== undefined && { description: data.description }),
      ...(data.type !== undefined && { type: data.type }),
      ...(data.costImpact !== undefined && { costImpact: data.costImpact }),
      ...(data.scheduleDaysImpact !== undefined && { scheduleDaysImpact: data.scheduleDaysImpact }),
      ...(data.status !== undefined && { status: data.status }),
    },
    select: CHANGE_SELECT,
  });
  await logPmFieldChanges(
    { orgId: ctx.orgId, subjectType: "change", subjectId: existing.id, userId: ctx.userId },
    { title: existing.title, status: existing.status, type: existing.type, scheduleDaysImpact: existing.scheduleDaysImpact },
    { title: updated.title, status: updated.status, type: updated.type, scheduleDaysImpact: updated.scheduleDaysImpact },
  );
  return { updated: true, id: updated.id, changeRequest: updated };
}
