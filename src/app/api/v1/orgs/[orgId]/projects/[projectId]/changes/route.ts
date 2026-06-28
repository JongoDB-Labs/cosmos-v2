import { NextRequest } from "next/server";
import { z } from "zod";
import { ChangeRequestStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

const changeInclude = { programBranch: { select: { id: true, code: true, name: true } } };

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

    const changes = await prisma.changeRequest.findMany({
      where: { orgId, projectId },
      include: changeInclude,
      orderBy: { createdAt: "desc" },
    });
    return success(changes);
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  type: z.string().max(80).nullish(),
  branchId: z.string().uuid().nullish(),
  initiatedBy: z.string().max(120).nullish(),
  decisionAuthority: z.string().max(120).nullish(),
  approvedBy: z.string().max(120).nullish(),
  costImpact: z.number().nullish(),
  scheduleDaysImpact: z.number().int().nullish(),
  modRequired: z.boolean().default(false),
  modNumber: z.string().max(80).nullish(),
  implDate: z.string().nullish(),
  relatedRiskCode: z.string().max(40).nullish(),
  status: z.nativeEnum(ChangeRequestStatus).default(ChangeRequestStatus.SUBMITTED),
});

/** Next CR-NNN code for the org (codes are unique per org). */
async function nextCode(orgId: string): Promise<string> {
  const rows = await prisma.changeRequest.findMany({ where: { orgId }, select: { code: true } });
  const max = rows.reduce((mx, r) => {
    const m = r.code.match(/^CR-(\d+)$/);
    return m ? Math.max(mx, Number(m[1])) : mx;
  }, 0);
  return `CR-${String(max + 1).padStart(3, "0")}`;
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

    const created = await prisma.changeRequest.create({
      data: {
        orgId,
        projectId,
        code: await nextCode(orgId),
        title: data.title,
        description: data.description ?? null,
        type: data.type ?? null,
        branchId: data.branchId ?? null,
        initiatedBy: data.initiatedBy ?? null,
        decisionAuthority: data.decisionAuthority ?? null,
        approvedBy: data.approvedBy ?? null,
        costImpact: data.costImpact ?? null,
        scheduleDaysImpact: data.scheduleDaysImpact ?? null,
        modRequired: data.modRequired,
        modNumber: data.modNumber ?? null,
        implDate: data.implDate ? new Date(data.implDate) : null,
        relatedRiskCode: data.relatedRiskCode ?? null,
        status: data.status,
      },
      include: changeInclude,
    });
    return success(created);
  } catch (e) {
    return handleApiError(e);
  }
}
