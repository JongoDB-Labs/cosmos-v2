import { NextRequest } from "next/server";
import { z } from "zod";
import { RagStatus, KeyResultStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { krFraction } from "@/lib/okr/progress";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; krId: string }>;
};

const checkinSchema = z.object({
  value: z.number(),
  confidence: z.number().int().min(0).max(100),
  rag: z.nativeEnum(RagStatus),
  note: z.string().max(2000).nullish(),
  blockers: z.string().max(2000).nullish(),
});

// The stoplight is the primary health signal; keep the legacy KeyResultStatus in
// step so existing views/filters stay meaningful (no BEHIND value — RED maps to
// AT_RISK, the strongest "needs attention" status available).
const RAG_TO_STATUS: Record<RagStatus, KeyResultStatus> = {
  GREEN: KeyResultStatus.ON_TRACK,
  YELLOW: KeyResultStatus.AT_RISK,
  RED: KeyResultStatus.AT_RISK,
};

async function loadScopedKr(orgId: string, projectId: string, krId: string) {
  return prisma.keyResult.findFirst({
    where: { id: krId, objective: { orgId, projectId } },
    include: { objective: { select: { projectId: true } } },
  });
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, krId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const kr = await loadScopedKr(orgId, projectId, krId);
    if (!kr) return new Response("Not found", { status: 404 });

    await requireAccess(ctx, "OKR_READ", {
      projectId: kr.objective.projectId,
      objectiveId: kr.objectiveId,
    });

    const checkins = await prisma.keyResultCheckin.findMany({
      where: { keyResultId: krId },
      orderBy: { createdAt: "desc" },
    });
    return success(checkins);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, krId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const kr = await loadScopedKr(orgId, projectId, krId);
    if (!kr) return new Response("Not found", { status: 404 });

    await requireAccess(ctx, "OKR_UPDATE", {
      ownerId: kr.ownerId,
      projectId: kr.objective.projectId,
      objectiveId: kr.objectiveId,
    });

    const data = checkinSchema.parse(await request.json());

    const checkin = await prisma.keyResultCheckin.create({
      data: {
        keyResultId: krId,
        value: data.value,
        confidence: data.confidence,
        rag: data.rag,
        note: data.note ?? null,
        blockers: data.blockers ?? null,
        checkedInById: ctx.userId,
      },
    });

    // Fold the check-in into the KR's live snapshot (value + latest confidence/rag
    // + a matching status), then recompute the parent objective's progress.
    await prisma.keyResult.update({
      where: { id: krId },
      data: {
        currentValue: data.value,
        confidence: data.confidence,
        rag: data.rag,
        status: RAG_TO_STATUS[data.rag],
      },
    });

    const siblings = await prisma.keyResult.findMany({
      where: { objectiveId: kr.objectiveId },
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
    await prisma.objective.update({
      where: { id: kr.objectiveId },
      data: { progress },
    });

    return created(checkin);
  } catch (e) {
    return handleApiError(e);
  }
}
