import { NextRequest } from "next/server";
import { z } from "zod";
import { RiskStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { computeRiskScore, riskLevelFromScore } from "@/lib/pm/risk";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; riskId: string }>;
};

const riskInclude = { programBranch: { select: { id: true, code: true, name: true } } };

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullish(),
  category: z.string().max(80).nullish(),
  branchId: z.string().uuid().nullish(),
  likelihood: z.number().int().min(1).max(5).optional(),
  impact: z.number().int().min(1).max(5).optional(),
  owner: z.string().max(120).nullish(),
  mitigation: z.string().nullish(),
  contingency: z.string().nullish(),
  status: z.nativeEnum(RiskStatus).optional(),
  trend: z.string().max(40).nullish(),
  escalate: z.boolean().optional(),
  targetDate: z.string().nullish(),
  dateIdentified: z.string().nullish(),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, riskId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.risk.findFirst({ where: { id: riskId, orgId, projectId } });
    if (!existing) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());

    // Recompute score + level when either driver changes.
    const likelihood = data.likelihood ?? existing.likelihood;
    const impact = data.impact ?? existing.impact;
    const recompute = data.likelihood !== undefined || data.impact !== undefined;
    const score = recompute ? computeRiskScore(likelihood, impact) : existing.score;

    const updated = await prisma.risk.update({
      where: { id: riskId },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.category !== undefined && { category: data.category }),
        ...(data.branchId !== undefined && { branchId: data.branchId }),
        ...(data.likelihood !== undefined && { likelihood: data.likelihood }),
        ...(data.impact !== undefined && { impact: data.impact }),
        ...(recompute && { score, level: riskLevelFromScore(score) }),
        ...(data.owner !== undefined && { owner: data.owner }),
        ...(data.mitigation !== undefined && { mitigation: data.mitigation }),
        ...(data.contingency !== undefined && { contingency: data.contingency }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.trend !== undefined && { trend: data.trend }),
        ...(data.escalate !== undefined && { escalate: data.escalate }),
        ...(data.targetDate !== undefined && {
          targetDate: data.targetDate ? new Date(data.targetDate) : null,
        }),
        ...(data.dateIdentified !== undefined && {
          dateIdentified: data.dateIdentified ? new Date(data.dateIdentified) : null,
        }),
      },
      include: riskInclude,
    });
    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, riskId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.risk.findFirst({ where: { id: riskId, orgId, projectId } });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.risk.delete({ where: { id: riskId } });
    return success({ id: riskId });
  } catch (e) {
    return handleApiError(e);
  }
}
