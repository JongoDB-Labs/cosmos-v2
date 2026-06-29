import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { loadClinsWithBurn } from "@/lib/pm/burn";
import { logPmActivity } from "@/lib/pm/activity-log";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

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

    const rows = await loadClinsWithBurn(orgId, projectId);
    return success(rows);
  } catch (e) {
    return handleApiError(e);
  }
}

const createSchema = z.object({
  code: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  value: z.number().nonnegative().default(0),
  fundedValue: z.number().nonnegative().default(0),
  popStart: z.string().nullish(),
  popEnd: z.string().nullish(),
  status: z.string().max(40).default("active"),
});

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
    const created = await prisma.clin.create({
      data: {
        orgId,
        projectId,
        code: data.code,
        title: data.title,
        value: data.value,
        fundedValue: data.fundedValue,
        popStart: data.popStart ? new Date(data.popStart) : null,
        popEnd: data.popEnd ? new Date(data.popEnd) : null,
        status: data.status,
      },
    });

    // Seed the activity log with a "created" event (best-effort).
    await logPmActivity({
      orgId,
      subjectType: "clin",
      subjectId: created.id,
      userId: ctx.userId,
      action: "created",
    });

    return success(created);
  } catch (e) {
    return handleApiError(e);
  }
}
