import { NextRequest } from "next/server";
import { z } from "zod";
import { BlockerType, BlockerStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { resolveBranchScope, branchScopeWhere } from "@/lib/rbac/branch-scope";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

const blockerInclude = { programBranch: { select: { id: true, code: true, name: true } } };

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
    const blockers = await prisma.blocker.findMany({
      where: { orgId, projectId, ...branchScopeWhere(branchScope) },
      include: blockerInclude,
      orderBy: { createdAt: "asc" },
    });
    return success(blockers);
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  type: z.nativeEnum(BlockerType).default(BlockerType.INTERNAL),
  branchId: z.string().uuid().nullish(),
  source: z.string().max(200).nullish(),
  identifiedBy: z.string().max(120).nullish(),
  owner: z.string().max(120).nullish(),
  whatUnblocks: z.string().nullish(),
  decisionAuthority: z.string().max(200).nullish(),
  relatedRiskCode: z.string().max(20).nullish(),
  customerNotified: z.boolean().default(false),
  customerNotifiedDate: z.string().nullish(),
  targetDate: z.string().nullish(),
  escalate: z.boolean().default(false),
  status: z.nativeEnum(BlockerStatus).default(BlockerStatus.OPEN),
});

/** Next BL-NNN code for the org (codes are unique per org). */
async function nextCode(orgId: string): Promise<string> {
  const rows = await prisma.blocker.findMany({ where: { orgId }, select: { code: true } });
  const max = rows.reduce((mx, b) => {
    const m = b.code.match(/^BL-(\d+)$/);
    return m ? Math.max(mx, Number(m[1])) : mx;
  }, 0);
  return `BL-${String(max + 1).padStart(3, "0")}`;
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

    const created = await prisma.blocker.create({
      data: {
        orgId,
        projectId,
        code: await nextCode(orgId),
        title: data.title,
        description: data.description ?? null,
        type: data.type,
        branchId: data.branchId ?? null,
        source: data.source ?? null,
        identifiedBy: data.identifiedBy ?? null,
        owner: data.owner ?? null,
        whatUnblocks: data.whatUnblocks ?? null,
        decisionAuthority: data.decisionAuthority ?? null,
        relatedRiskCode: data.relatedRiskCode ?? null,
        customerNotified: data.customerNotified,
        customerNotifiedDate: data.customerNotifiedDate ? new Date(data.customerNotifiedDate) : null,
        targetDate: data.targetDate ? new Date(data.targetDate) : null,
        escalate: data.escalate,
        status: data.status,
        // identifiedAt defaults to now() in schema
      },
      include: blockerInclude,
    });
    return success(created);
  } catch (e) {
    return handleApiError(e);
  }
}
