import { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; clinId: string }>;
};

const updateSchema = z.object({
  code: z.string().min(1).max(40).optional(),
  title: z.string().min(1).max(200).optional(),
  value: z.number().nonnegative().optional(),
  fundedValue: z.number().nonnegative().optional(),
  popStart: z.string().nullish(),
  popEnd: z.string().nullish(),
  status: z.string().max(40).optional(),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, clinId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.clin.findFirst({ where: { id: clinId, orgId, projectId } });
    if (!existing) return new Response("Not found", { status: 404 });

    const data = updateSchema.parse(await request.json());
    const update: Prisma.ClinUncheckedUpdateInput = {};
    if (data.code !== undefined) update.code = data.code;
    if (data.title !== undefined) update.title = data.title;
    if (data.value !== undefined) update.value = data.value;
    if (data.fundedValue !== undefined) update.fundedValue = data.fundedValue;
    if (data.status !== undefined) update.status = data.status;
    if (data.popStart !== undefined) update.popStart = data.popStart ? new Date(data.popStart) : null;
    if (data.popEnd !== undefined) update.popEnd = data.popEnd ? new Date(data.popEnd) : null;

    const updated = await prisma.clin.update({ where: { id: clinId }, data: update });
    return success(updated);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, clinId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const existing = await prisma.clin.findFirst({ where: { id: clinId, orgId, projectId } });
    if (!existing) return new Response("Not found", { status: 404 });

    await prisma.clin.delete({ where: { id: clinId } });
    return success({ id: clinId });
  } catch (e) {
    return handleApiError(e);
  }
}
