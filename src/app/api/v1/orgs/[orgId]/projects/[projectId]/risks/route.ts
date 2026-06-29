import { NextRequest } from "next/server";
import { z } from "zod";
import { RiskStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { resolveBranchScope, branchScopeWhere } from "@/lib/rbac/branch-scope";
import { computeRiskScore, riskLevelFromScore } from "@/lib/pm/risk";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

const riskInclude = { programBranch: { select: { id: true, code: true, name: true } } };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ANALYTICS_READ);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const branchScope = await resolveBranchScope(orgId, ctx.userId);
    const risks = await prisma.risk.findMany({
      where: { orgId, projectId, ...branchScopeWhere(branchScope) },
      include: riskInclude,
      orderBy: [{ score: "desc" }, { createdAt: "desc" }],
    });
    return success(risks);
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  category: z.string().max(80).nullish(),
  branchId: z.string().uuid().nullish(),
  likelihood: z.number().int().min(1).max(5).default(1),
  impact: z.number().int().min(1).max(5).default(1),
  owner: z.string().max(120).nullish(),
  mitigation: z.string().nullish(),
  contingency: z.string().nullish(),
  status: z.nativeEnum(RiskStatus).default(RiskStatus.OPEN),
  trend: z.string().max(40).nullish(),
  escalate: z.boolean().default(false),
  targetDate: z.string().nullish(),
  dateIdentified: z.string().nullish(),
});

/** Next R-NNN code for the org (codes are unique per org). */
async function nextCode(orgId: string): Promise<string> {
  const rows = await prisma.risk.findMany({ where: { orgId }, select: { code: true } });
  const max = rows.reduce((mx, r) => {
    const m = r.code.match(/^R-(\d+)$/);
    return m ? Math.max(mx, Number(m[1])) : mx;
  }, 0);
  return `R-${String(max + 1).padStart(3, "0")}`;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const data = createSchema.parse(await request.json());
    const score = computeRiskScore(data.likelihood, data.impact);

    const created = await prisma.risk.create({
      data: {
        orgId,
        projectId,
        code: await nextCode(orgId),
        title: data.title,
        description: data.description ?? null,
        category: data.category ?? null,
        branchId: data.branchId ?? null,
        likelihood: data.likelihood,
        impact: data.impact,
        score,
        level: riskLevelFromScore(score),
        owner: data.owner ?? null,
        mitigation: data.mitigation ?? null,
        contingency: data.contingency ?? null,
        status: data.status,
        trend: data.trend ?? null,
        escalate: data.escalate,
        targetDate: data.targetDate ? new Date(data.targetDate) : null,
        dateIdentified: data.dateIdentified ? new Date(data.dateIdentified) : new Date(),
      },
      include: riskInclude,
    });
    return success(created);
  } catch (e) {
    return handleApiError(e);
  }
}
