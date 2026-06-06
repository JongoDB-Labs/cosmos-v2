import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const createEntrySchema = z.object({
  cidr: z.string().min(1).max(50),
  label: z.string().max(200).nullish(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.SECURITY_MANAGE);

    const entries = await prisma.ipAllowlist.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });

    return success(entries);
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
    requirePermission(ctx, Permission.SECURITY_MANAGE);

    const body = await request.json();
    const data = createEntrySchema.parse(body);

    const entry = await prisma.ipAllowlist.create({
      data: {
        orgId,
        cidr: data.cidr,
        label: data.label ?? "",
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "ip_allowlist.created",
      entity: "ip_allowlist",
      entityId: entry.id,
      metadata: { cidr: data.cidr } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(entry);
  } catch (error) {
    return handleApiError(error);
  }
}
