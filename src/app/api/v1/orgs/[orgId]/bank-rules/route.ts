import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";

const createSchema = z.object({
  name: z.string().trim().default(""),
  descriptionContains: z.string().trim().min(1).nullish(),
  direction: z.enum(["any", "inflow", "outflow"]).default("any"),
  amountMin: z.number().nonnegative().nullish(),
  amountMax: z.number().nonnegative().nullish(),
  category: z.string().trim().min(1),
  priority: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

type RouteParams = { params: Promise<{ orgId: string }> };

async function authorize(orgId: string, permission: bigint) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  requirePermission(ctx, permission);
  return { ctx };
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const auth = await authorize(orgId, Permission.FINANCE_READ);
    if (auth.error) return auth.error;

    const data = await prisma.bankRule.findMany({
      where: { orgId },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    });
    return success({ data, total: data.length });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const auth = await authorize(orgId, Permission.FINANCE_MANAGE);
    if (auth.error) return auth.error;

    const input = createSchema.parse(await request.json());
    const rule = await prisma.bankRule.create({
      data: {
        orgId,
        name: input.name,
        descriptionContains: input.descriptionContains ?? null,
        direction: input.direction,
        amountMin: input.amountMin ?? null,
        amountMax: input.amountMax ?? null,
        category: input.category,
        priority: input.priority,
        isActive: input.isActive,
        createdById: auth.ctx.userId,
      },
    });
    return success(rule);
  } catch (error) {
    return handleApiError(error);
  }
}
