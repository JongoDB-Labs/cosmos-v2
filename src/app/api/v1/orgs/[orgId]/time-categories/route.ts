import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import {
  internalCategories,
  normalizeInternalCategories,
  MAX_INTERNAL_CATEGORIES,
  MAX_INTERNAL_CATEGORY_LENGTH,
} from "@/lib/time/internal-categories";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * The org's internal time categories (src/lib/time/internal-categories.ts).
 *
 * GET  the list and whether the caller may change it, for anyone who logs
 *      time (the Log Time dialog offers the list).
 * PUT  the whole list with ORG_MANAGE_SETTINGS; audited. An empty list is
 *      allowed and turns the category picker off.
 */
async function load(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, settings: true } });
  if (!org) return { org: null, ctx: null };
  return { org, ctx: await getAuthContext(org.slug) };
}

const putSchema = z.strictObject({
  categories: z.array(z.string().max(MAX_INTERNAL_CATEGORY_LENGTH)).max(MAX_INTERNAL_CATEGORIES),
});

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { org, ctx } = await load((await params).orgId);
    if (!org) return new Response("Not found", { status: 404 });
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.TIME_READ);
    return success({
      categories: internalCategories(org.settings),
      canManage: hasPermission(ctx.permissions, Permission.ORG_MANAGE_SETTINGS),
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
    requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);

    const categories = normalizeInternalCategories(putSchema.parse(await request.json()).categories);
    const before = internalCategories(org.settings);
    // Merged in one statement, so a concurrent change to any other org setting
    // is not overwritten by a stale read.
    const [row] = await prisma.$queryRaw<{ settings: unknown }[]>`
      UPDATE organizations
      SET settings = jsonb_set(
        COALESCE(settings, '{}'::jsonb), '{time}',
        COALESCE(settings->'time', '{}'::jsonb) || ${JSON.stringify({ internalCategories: categories })}::jsonb
      )
      WHERE id = ${org.id}::uuid
      RETURNING settings
    `;
    const after = internalCategories(row?.settings);
    await logAudit({
      orgId: org.id,
      userId: ctx.userId,
      action: "time.internal_categories_updated",
      entity: "organization",
      entityId: org.id,
      metadata: { before: before.join(", "), after: after.join(", ") },
      ipAddress: getIpAddress(request),
    });
    return success({ categories: after });
  } catch (error) {
    return handleApiError(error);
  }
}
