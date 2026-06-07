import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; milestoneId: string }>;
};

const createSchema = z.object({
  workItemId: z.string().uuid(),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, milestoneId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const milestone = await prisma.milestone.findFirst({
      where: { id: milestoneId, orgId, projectId },
    });
    if (!milestone) return new Response("Not found", { status: 404 });

    const data = createSchema.parse(await request.json());

    // The work item must belong to the same org+project.
    const workItem = await prisma.workItem.findFirst({
      where: { id: data.workItemId, orgId, projectId },
      select: { id: true },
    });
    if (!workItem) return new Response("Not found", { status: 404 });

    // Idempotent: if the link already exists, return it instead of erroring.
    const existing = await prisma.milestoneLink.findFirst({
      where: { milestoneId, workItemId: data.workItemId },
    });
    if (existing) return success(existing);

    const link = await prisma.milestoneLink.create({
      data: { milestoneId, workItemId: data.workItemId },
    });

    return success(link);
  } catch (e) {
    return handleApiError(e);
  }
}
