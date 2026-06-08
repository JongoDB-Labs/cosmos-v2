import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { updateEmployee } from "@/lib/payroll/service";
import { employeeUpdateSchema } from "@/lib/payroll/validation";

type RouteParams = { params: Promise<{ orgId: string; employeeId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, employeeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_READ);

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
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    const input = employeeUpdateSchema.parse(await request.json());
    return success(await updateEmployee(orgId, employeeId, input));
  } catch (error) {
    return handleApiError(error);
  }
}
