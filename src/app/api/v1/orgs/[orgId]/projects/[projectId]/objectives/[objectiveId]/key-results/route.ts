import { NextRequest } from "next/server";
import { z } from "zod";
import { KeyResultStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireAccess } from "@/lib/abac/require-access";
import { created, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; objectiveId: string }>;
};

const createSchema = z.object({
  title: z.string().min(1).max(200),
  startValue: z.number().default(0),
  currentValue: z.number().default(0),
  targetValue: z.number().default(100),
  unit: z.string().max(40).optional(),
  status: z.nativeEnum(KeyResultStatus).default(KeyResultStatus.IN_PROGRESS),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, objectiveId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    // Scope check: the objective must belong to this org + project.
    const objective = await prisma.objective.findFirst({
      where: { id: objectiveId, orgId, projectId },
    });
    if (!objective) return new Response("Not found", { status: 404 });

    // Resource-aware authz (OKR_CREATE + any narrowing deny policy) on the
    // parent objective. Identical to requirePermission until a policy references
    // OKR_CREATE.
    await requireAccess(ctx, "OKR_CREATE", {
      ownerId: objective.ownerId,
      projectId: objective.projectId,
      objectiveId,
    });

    const data = createSchema.parse(await request.json());

    // Append to the end of the existing key results.
    const last = await prisma.keyResult.findFirst({
      where: { objectiveId },
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });
    const sortOrder = last ? last.sortOrder + 1 : 0;

    const createdKr = await prisma.keyResult.create({
      data: {
        objectiveId,
        title: data.title,
        startValue: data.startValue,
        currentValue: data.currentValue,
        targetValue: data.targetValue,
        unit: data.unit ?? "",
        status: data.status,
        sortOrder,
      },
    });

    return created(createdKr);
  } catch (e) {
    return handleApiError(e);
  }
}
