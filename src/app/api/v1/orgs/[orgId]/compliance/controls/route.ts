import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { ComplianceFramework, ControlStatus } from "@prisma/client";

const createControlSchema = z.object({
  framework: z.nativeEnum(ComplianceFramework),
  controlId: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  description: z.string().nullish(),
  status: z.nativeEnum(ControlStatus).optional(),
  notes: z.string().nullish(),
  dueDate: z.string().datetime().nullish(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.COMPLIANCE_READ);

    const framework = request.nextUrl.searchParams.get("framework");
    const status = request.nextUrl.searchParams.get("status");

    const controls = await prisma.complianceControl.findMany({
      where: {
        orgId,
        ...(framework ? { framework: framework as ComplianceFramework } : {}),
        ...(status ? { status: status as ControlStatus } : {}),
      },
      orderBy: { controlId: "asc" },
    });

    return success(controls);
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
    requirePermission(ctx, Permission.COMPLIANCE_MANAGE);

    const body = await request.json();
    const data = createControlSchema.parse(body);

    const control = await prisma.complianceControl.create({
      data: {
        orgId,
        framework: data.framework,
        controlId: data.controlId,
        title: data.title,
        description: data.description ?? "",
        status: data.status ?? "NOT_ASSESSED",
        notes: data.notes ?? "",
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "compliance_control.created",
      entity: "compliance_control",
      entityId: control.id,
      metadata: { framework: data.framework, controlId: data.controlId } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(control);
  } catch (error) {
    return handleApiError(error);
  }
}
