import { NextRequest } from "next/server";
import { z } from "zod";
import { DeliverableStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { logPmActivity } from "@/lib/pm/activity-log";
import { classificationOmit } from "@/lib/compliance/classification";
import { assertOrgMember } from "@/lib/rbac/assert-org-member";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

const deliverableInclude = {
  ownerUser: { select: { id: true, displayName: true, avatarUrl: true } },
};

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "ANALYTICS_READ");

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const deliverables = await prisma.deliverable.findMany({
      where: { orgId, projectId },
      include: deliverableInclude,
      omit: classificationOmit(org.tenantClass),
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
  owner: z.string().max(120).nullish(),
  ownerUserId: z.string().uuid().nullish(),
  baselineDue: z.string().nullish(),
  internalReview: z.string().nullish(),
  actualSubmission: z.string().nullish(),
  govReviewPeriod: z.number().int().nullish(),
  govAcceptance: z.string().nullish(),
  revisionCycle: z.number().int().nullish(),
  revRequired: z.boolean().default(false),
  escalate: z.boolean().default(false),
  status: z.nativeEnum(DeliverableStatus).default(DeliverableStatus.NOT_STARTED),
  workItemRef: z.string().nullish(),
  notes: z.string().nullish(),
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
    await requireProjectManage(ctx, projectId, Permission.PROJECT_UPDATE);

    const project = await prisma.project.findFirst({ where: { id: projectId, orgId } });
    if (!project) return new Response("Not found", { status: 404 });

    const data = createSchema.parse(await request.json());
    // A client-supplied user id is not constrained to this org by anything
    // else in the write path — check membership or leak a foreign user.
    if (data.ownerUserId) await assertOrgMember(orgId, data.ownerUserId);

    const created = await prisma.deliverable.create({
      data: {
        orgId,
        projectId,
        code: await nextCode(orgId),
        title: data.title,
        description: data.description ?? null,
        deliverableType: data.deliverableType ?? null,
        clin: data.clin ?? null,
        owner: data.owner ?? null,
        ownerUserId: data.ownerUserId ?? null,
        baselineDue: data.baselineDue ? new Date(data.baselineDue) : null,
        internalReview: data.internalReview ? new Date(data.internalReview) : null,
        actualSubmission: data.actualSubmission ? new Date(data.actualSubmission) : null,
        govReviewPeriod: data.govReviewPeriod ?? null,
        govAcceptance: data.govAcceptance ? new Date(data.govAcceptance) : null,
        revisionCycle: data.revisionCycle ?? 0,
        revRequired: data.revRequired,
        escalate: data.escalate,
        status: data.status,
        workItemRef: data.workItemRef ?? null,
        notes: data.notes ?? null,
      },
      include: deliverableInclude,
      omit: classificationOmit(org.tenantClass),
    });

    // Seed the activity log with a "created" event (best-effort).
    await logPmActivity({
      orgId,
      subjectType: "deliverable",
      subjectId: created.id,
      userId: ctx.userId,
      action: "created",
    });

    return success(created);
  } catch (e) {
    return handleApiError(e);
  }
}
