import { prisma } from "@/lib/db/client";
import { RiskStatus } from "@prisma/client";
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
