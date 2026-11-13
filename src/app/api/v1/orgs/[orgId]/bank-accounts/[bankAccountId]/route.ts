import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { z } from "zod";
import { requireAccess } from "@/lib/abac/require-access";
import { logAudit } from "@/lib/audit";

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
    await requireAccess(ctx, "FINANCE_MANAGE");

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
    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "bank_account.updated",
      entity: "bank_account",
      entityId: bankAccountId,
      metadata: { changed: Object.keys(data) },
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}
