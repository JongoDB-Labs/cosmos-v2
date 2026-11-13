import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { requireProjectRead, requireProjectVisible } from "@/lib/rbac/require-project-read";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { memberDisclosure, type MemberDisclosure } from "@/lib/members/scoped-roster.server";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; intervalId: string }> };

type CapacityRow = { userId: string; user: { id: string; displayName: string; email: string; avatarUrl: string | null } };

/** Each row's person only inside the caller's roster ceiling, with an email only for members:read. */
function disclose<T extends CapacityRow>(rows: T[], people: MemberDisclosure) {
  return rows
    .filter((r) => people.inRoster(r.userId))
    .map(({ user: { email, ...user }, ...row }) => ({ ...row, user: people.emails ? { ...user, email } : user }));
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, intervalId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "SPRINT_READ");

    // The sprint must belong to the project the access check just passed:
    // matching on the interval id alone answered for any sprint, in any project.
    const capacities = await prisma.intervalCapacity.findMany({
      where: { intervalId, interval: { projectId, orgId: ctx.orgId } },
      include: {
        user: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
      },
      orderBy: { user: { displayName: "asc" } },
    });

    return success(disclose(capacities, await memberDisclosure(ctx)));
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
    const { orgId, projectId, intervalId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectVisible(ctx, projectId);
    await requireProjectManage(ctx, projectId, Permission.SPRINT_UPDATE);

    const interval = await prisma.interval.findFirst({
      where: { id: intervalId, orgId: ctx.orgId, projectId },
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

    return success(disclose(updated, await memberDisclosure(ctx)));
  } catch (e) {
    return handleApiError(e);
  }
}
