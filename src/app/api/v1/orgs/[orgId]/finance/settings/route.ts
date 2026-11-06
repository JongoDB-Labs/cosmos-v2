import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { financeSettings, MAX_MARKUP_PCT } from "@/lib/finance/markup";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * The org's finance settings (src/lib/finance/markup.ts): the default markup
 * on reimbursable costs, and whether an invoice shows a marked-up cost as one
 * line or two.
 *
 * GET  with FINANCE_READ, and whether the caller may change them.
 * PUT  with FINANCE_MANAGE; audited. Omitted fields keep their value.
 */
async function load(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, settings: true } });
  if (!org) return { org: null, ctx: null };
  return { org, ctx: await getAuthContext(org.slug) };
}

const putSchema = z.strictObject({
  reimbursableMarkupPct: z.number().finite().min(0).max(MAX_MARKUP_PCT).optional(),
  reimbursableLines: z.enum(["one", "two"]).optional(),
});

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { org, ctx } = await load((await params).orgId);
    if (!org) return new Response("Not found", { status: 404 });
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_READ);
    return success({
      ...financeSettings(org.settings),
      canManage: hasPermission(ctx.permissions, Permission.FINANCE_MANAGE),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { org, ctx } = await load((await params).orgId);
    if (!org) return new Response("Not found", { status: 404 });
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.FINANCE_MANAGE);

    const patch = putSchema.parse(await request.json());
    const before = financeSettings(org.settings);
    // Merged in one statement, so a concurrent change to any other org setting
    // (or to the other finance field) is not overwritten by a stale read.
    const [row] = await prisma.$queryRaw<{ settings: unknown }[]>`
      UPDATE organizations
      SET settings = jsonb_set(
        COALESCE(settings, '{}'::jsonb), '{finance}',
        COALESCE(settings->'finance', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
      )
      WHERE id = ${org.id}::uuid
      RETURNING settings
    `;
    const after = financeSettings(row?.settings);
    await logAudit({
      orgId: org.id,
      userId: ctx.userId,
      action: "finance.settings_updated",
      entity: "organization",
      entityId: org.id,
      metadata: {
        before: `${before.reimbursableMarkupPct}%, ${before.reimbursableLines} line`,
        after: `${after.reimbursableMarkupPct}%, ${after.reimbursableLines} line`,
      },
      ipAddress: getIpAddress(request),
    });
    return success(after);
  } catch (error) {
    return handleApiError(error);
  }
}
