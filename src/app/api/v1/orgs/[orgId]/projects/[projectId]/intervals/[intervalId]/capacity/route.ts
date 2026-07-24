import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; intervalId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, intervalId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SPRINT_READ);

    const capacities = await prisma.intervalCapacity.findMany({
      where: { intervalId },
      include: {
        user: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
      },
      orderBy: { user: { displayName: "asc" } },
    });

    return success(capacities);
  } catch (e) {
    return handleApiError(e);
  }
}

const upsertSchema = z.object({
  entries: z.array(z.object({
    userId: z.string().uuid(),
    capacity: z.number().nonnegative(),
    notes: z.string().max(500).nullish(),
  })).min(0).max(100),
});

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, intervalId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SPRINT_UPDATE);

    const interval = await prisma.interval.findFirst({
      where: { id: intervalId, orgId: ctx.orgId },
    });
    if (!interval) return new Response("Interval not found", { status: 404 });

    const body = upsertSchema.parse(await request.json());

    // Upsert each entry; remove entries not in the payload
    const userIds = body.entries.map((e) => e.userId);

    await prisma.$transaction([
      prisma.intervalCapacity.deleteMany({
        where: { intervalId, NOT: { userId: { in: userIds.length > 0 ? userIds : ["00000000-0000-0000-0000-000000000000"] } } },
      }),
      ...body.entries.map((e) =>
        prisma.intervalCapacity.upsert({
          where: { intervalId_userId: { intervalId, userId: e.userId } },
          create: { intervalId, userId: e.userId, capacity: e.capacity, notes: e.notes ?? "" },
          update: { capacity: e.capacity, notes: e.notes ?? "" },
        })
      ),
    ]);

    const updated = await prisma.intervalCapacity.findMany({
      where: { intervalId },
      include: {
        user: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
      },
      orderBy: { user: { displayName: "asc" } },
    });

    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}
