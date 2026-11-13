import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { updateEmployee } from "@/lib/payroll/service";
import { employeeUpdateSchema } from "@/lib/payroll/validation";
import { requireAccess } from "@/lib/abac/require-access";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string; employeeId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, employeeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "FINANCE_READ");

    const employee = await prisma.employee.findFirst({ where: { id: employeeId, orgId } });
    if (!employee) return new Response("Not found", { status: 404 });
    return success(employee);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, employeeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "FINANCE_MANAGE");

    const input = employeeUpdateSchema.parse(await request.json());
    const employee = await updateEmployee(orgId, employeeId, input, ctx.userId);
    // Which fields changed, never their values: a cost rate is pay, and the
    // audit log is read by people who may not see pay.
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "employee.updated",
      entity: "employee",
      entityId: employeeId,
      metadata: { changed: Object.keys(input) },
      ipAddress: getIpAddress(request),
    });
    return success(employee);
  } catch (error) {
    return handleApiError(error);
  }
}
