import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { z } from "zod";

const updateBankAccountSchema = z.object({
  name: z.string().min(1).optional(),
  institution: z.string().optional(),
  mask: z.string().optional(),
  isActive: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; bankAccountId: string }> };

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, bankAccountId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    const existing = await prisma.bankAccount.findFirst({
      where: { id: bankAccountId, orgId },
    });
    if (!existing) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const data = updateBankAccountSchema.parse(body);

    const updated = await prisma.bankAccount.update({
      where: { id: bankAccountId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.institution !== undefined && { institution: data.institution }),
        ...(data.mask !== undefined && { mask: data.mask }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
