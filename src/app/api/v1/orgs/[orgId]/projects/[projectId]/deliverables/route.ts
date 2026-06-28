import { NextRequest } from "next/server";
import { z } from "zod";
import { DeliverableStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

const deliverableInclude = { programBranch: { select: { id: true, code: true, name: true } } };

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

    const deliverables = await prisma.deliverable.findMany({
      where: { orgId, projectId },
      include: deliverableInclude,
      orderBy: [{ baselineDue: "asc" }, { createdAt: "desc" }],
    });
    return success(deliverables);
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().nullish(),
  deliverableType: z.string().max(80).nullish(),
  clin: z.string().max(80).nullish(),
  branchId: z.string().uuid().nullish(),
  owner: z.string().max(120).nullish(),
  baselineDue: z.string().nullish(),
  internalReview: z.string().nullish(),
  actualSubmission: z.string().nullish(),
  govReviewPeriod: z.number().int().nullish(),
  govAcceptance: z.string().nullish(),
  revisionCycle: z.number().int().nullish(),
  revRequired: z.boolean().default(false),
  escalate: z.boolean().default(false),
  status: z.nativeEnum(DeliverableStatus).default(DeliverableStatus.NOT_STARTED),
});

/** Next CDRL-A00N code for the org (codes are unique per org). */
async function nextCode(orgId: string): Promise<string> {
  const rows = await prisma.deliverable.findMany({ where: { orgId }, select: { code: true } });
  const max = rows.reduce((mx, r) => {
    const m = r.code.match(/^CDRL-A(\d+)$/);
    return m ? Math.max(mx, Number(m[1])) : mx;
  }, 0);
  return `CDRL-A${String(max + 1).padStart(3, "0")}`;
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

    const created = await prisma.deliverable.create({
      data: {
        orgId,
        projectId,
        code: await nextCode(orgId),
        title: data.title,
        description: data.description ?? null,
        deliverableType: data.deliverableType ?? null,
        clin: data.clin ?? null,
        branchId: data.branchId ?? null,
        owner: data.owner ?? null,
        baselineDue: data.baselineDue ? new Date(data.baselineDue) : null,
        internalReview: data.internalReview ? new Date(data.internalReview) : null,
        actualSubmission: data.actualSubmission ? new Date(data.actualSubmission) : null,
        govReviewPeriod: data.govReviewPeriod ?? null,
        govAcceptance: data.govAcceptance ? new Date(data.govAcceptance) : null,
        revisionCycle: data.revisionCycle ?? 0,
        revRequired: data.revRequired,
        escalate: data.escalate,
        status: data.status,
      },
      include: deliverableInclude,
    });
    return success(created);
  } catch (e) {
    return handleApiError(e);
  }
}
