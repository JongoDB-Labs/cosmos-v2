import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

const patchSchema = z.object({
  name: z.string().trim().optional(),
  descriptionContains: z.string().trim().min(1).nullish(),
  direction: z.enum(["any", "inflow", "outflow"]).optional(),
  amountMin: z.number().nonnegative().nullish(),
  amountMax: z.number().nonnegative().nullish(),
  category: z.string().trim().min(1).optional(),
  priority: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; ruleId: string }> };

async function manageGate(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return new Response("Not found", { status: 404 });
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return new Response("Unauthorized", { status: 401 });
  requirePermission(ctx, Permission.FINANCE_MANAGE);
  return null;
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, ruleId } = await params;
    const gate = await manageGate(orgId);
    if (gate) return gate;

    const input = patchSchema.parse(await request.json());
    // Scope the update to the org so a rule from another tenant can't be touched.
    const updated = await prisma.bankRule.updateMany({
      where: { id: ruleId, orgId },
      data: input,
    });
    if (updated.count === 0) return new Response("Not found", { status: 404 });
    const rule = await prisma.bankRule.findUnique({ where: { id: ruleId } });
    if (!rule) return new Response("Not found", { status: 404 });
    return success(rule);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, ruleId } = await params;
    const gate = await manageGate(orgId);
    if (gate) return gate;

    const deleted = await prisma.bankRule.deleteMany({ where: { id: ruleId, orgId } });
    if (deleted.count === 0) return new Response("Not found", { status: 404 });
    return success({ id: ruleId, deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
