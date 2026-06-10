import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { ClassificationLevel } from "@prisma/client";

const createClassificationSchema = z.object({
  projectId: z.string().uuid().nullish(),
  level: z.nativeEnum(ClassificationLevel),
  markings: z.array(z.string()).optional(),
  handlingInstructions: z.string().nullish(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CLASSIFICATION_READ);

    const projectId = request.nextUrl.searchParams.get("projectId");
    const level = request.nextUrl.searchParams.get("level");

    const classifications = await prisma.dataClassification.findMany({
      where: {
        orgId,
        ...(projectId ? { projectId } : {}),
        ...(level ? { level: level as ClassificationLevel } : {}),
      },
      orderBy: { createdAt: "desc" },
    });

    // Resolve applier display names so the UI shows a name, not a raw UUID.
    // A side query (not a Prisma relation) keeps this migration-free and never
    // touches OrgMember.permissions (BigInt). Map id → displayName.
    const applierIds = [...new Set(classifications.map((c) => c.appliedById))];
    const appliers = applierIds.length
      ? await prisma.user.findMany({
          where: { id: { in: applierIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const nameById = new Map(appliers.map((u) => [u.id, u.displayName]));

    return success(
      classifications.map((c) => ({
        ...c,
        appliedByName: nameById.get(c.appliedById) ?? null,
      })),
    );
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.CLASSIFICATION_MANAGE);

    const body = await request.json();
    const data = createClassificationSchema.parse(body);

    let classification;

    if (data.projectId) {
      classification = await prisma.dataClassification.upsert({
        where: {
          orgId_projectId: {
            orgId,
            projectId: data.projectId,
          },
        },
        create: {
          orgId,
          projectId: data.projectId,
          level: data.level,
          markings: data.markings ?? [],
          handlingInstructions: data.handlingInstructions ?? "",
          appliedById: ctx.userId,
        },
        update: {
          level: data.level,
          markings: data.markings ?? [],
          handlingInstructions: data.handlingInstructions ?? "",
          appliedById: ctx.userId,
        },
      });
    } else {
      const existing = await prisma.dataClassification.findFirst({
        where: { orgId, projectId: null },
      });

      if (existing) {
        classification = await prisma.dataClassification.update({
          where: { id: existing.id },
          data: {
            level: data.level,
            markings: data.markings ?? [],
            handlingInstructions: data.handlingInstructions ?? "",
            appliedById: ctx.userId,
          },
        });
      } else {
        classification = await prisma.dataClassification.create({
          data: {
            orgId,
            projectId: null,
            level: data.level,
            markings: data.markings ?? [],
            handlingInstructions: data.handlingInstructions ?? "",
            appliedById: ctx.userId,
          },
        });
      }
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "data_classification.upserted",
      entity: "data_classification",
      entityId: classification.id,
      metadata: { level: data.level, projectId: data.projectId ?? "org-level" } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(classification);
  } catch (error) {
    return handleApiError(error);
  }
}
