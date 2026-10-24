import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { cqlEnabled } from "@/lib/query/flag";
import { patchCqlSettings } from "@/lib/query/route.server";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * The org switch for the query language (CQL) beta. Outside /cql/ on purpose:
 * every /cql/ route answers 404 while the switch is off, and this is how it
 * gets turned on.
 *
 * GET  { enabled, canManage } for any member: the settings card, and
 *      useCqlSchema, which asks for /cql/schema only when this says on.
 * PUT  { enabled } with ORG_MANAGE_SETTINGS; audited.
 */
async function load(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, settings: true } });
  if (!org) return { org: null, ctx: null };
  return { org, ctx: await getAuthContext(org.slug) };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { org, ctx } = await load((await params).orgId);
    if (!org) return new Response("Not found", { status: 404 });
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    return success({ enabled: cqlEnabled(org.settings), canManage: hasPermission(ctx.permissions, Permission.ORG_MANAGE_SETTINGS) });
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

    const { enabled } = z.strictObject({ enabled: z.boolean() }).parse(await request.json());
    const before = cqlEnabled({ cql: await patchCqlSettings(org.id, { enabled }) });
    if (before !== enabled) {
      await logAudit({
        orgId: org.id, userId: ctx.userId, action: enabled ? "cql.enabled" : "cql.disabled",
        entity: "organization", entityId: org.id, metadata: {}, ipAddress: getIpAddress(request),
      });
    }
    return success({ enabled });
  } catch (error) {
    return handleApiError(error);
  }
}
