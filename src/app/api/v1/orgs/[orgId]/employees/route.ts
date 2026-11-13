import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { createEmployee, listEmployees } from "@/lib/payroll/service";
import { employeeSchema } from "@/lib/payroll/validation";
import { requireAccess } from "@/lib/abac/require-access";
import { logAudit } from "@/lib/audit";

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireAccess(ctx, "FINANCE_READ");

    const data = await listEmployees(orgId);
    return success({ data, total: data.length });
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
    await requireAccess(ctx, "FINANCE_MANAGE");

    const input = employeeSchema.parse(await request.json());
    const employee = await createEmployee(orgId, ctx.userId, input);
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "employee.created",
      entity: "employee",
      entityId: employee.id,
      metadata: { userId: input.userId },
      ipAddress: getIpAddress(request),
    });
    return success(employee);
  } catch (error) {
    return handleApiError(error);
  }
}
