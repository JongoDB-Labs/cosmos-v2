import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { z } from "zod";

const createBankAccountSchema = z.object({
  name: z.string().min(1),
  institution: z.string().optional(),
  mask: z.string().optional(),
  currency: z.string().optional(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_READ);

    const accounts = await prisma.bankAccount.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });

    return success({ data: accounts, total: accounts.length });
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
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    const body = await request.json();
    const data = createBankAccountSchema.parse(body);

    const account = await prisma.bankAccount.create({
      data: {
        orgId,
        name: data.name,
        institution: data.institution,
        mask: data.mask,
        currency: data.currency ?? "USD",
        createdById: ctx.userId,
      },
    });

    return created(account);
  } catch (error) {
    return handleApiError(error);
  }
}
