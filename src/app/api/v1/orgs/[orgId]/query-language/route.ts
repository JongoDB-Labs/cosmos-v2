import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { cqlEmailTitles, cqlEnabled } from "@/lib/query/flag";
import { patchCqlSettings } from "@/lib/query/route.server";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * The org switch for the query language (CQL) beta. Outside /cql/ on purpose:
 * every /cql/ route answers 404 while the switch is off, and this is how it
 * gets turned on.
 *
 * GET  { enabled, emailTitles, canManage } for any member: the settings card,
 *      and useCqlSchema, which asks for /cql/schema only when this says on.
 * PUT  { enabled?, emailTitles? } with ORG_MANAGE_SETTINGS; each change audited.
 *      emailTitles: may filter subscription emails carry item titles (§6.6).
 */
async function load(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, settings: true, tenantClass: true } });
  if (!org) return { org: null, ctx: null };
  return { org, ctx: await getAuthContext(org.slug) };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { org, ctx } = await load((await params).orgId);
    if (!org) return new Response("Not found", { status: 404 });
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    return success({
      enabled: cqlEnabled(org.settings),
      emailTitles: cqlEmailTitles(org.settings, org.tenantClass),
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

    const body = z
      .strictObject({ enabled: z.boolean().optional(), emailTitles: z.boolean().optional() })
      .refine((b) => b.enabled !== undefined || b.emailTitles !== undefined, "Send enabled or emailTitles")
      .parse(await request.json());
    const patch: Record<string, boolean> = {};
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.emailTitles !== undefined) patch.emailTitles = body.emailTitles;
    // One atomic merge; `old` is the cql settings as they were, for the audit.
    const old = { cql: await patchCqlSettings(org.id, patch) };
    const before = { enabled: cqlEnabled(old), emailTitles: cqlEmailTitles(old, org.tenantClass) };
    const audit = (action: string) =>
      logAudit({ orgId: org.id, userId: ctx.userId, action, entity: "organization", entityId: org.id, metadata: {}, ipAddress: getIpAddress(request) });
    if (body.enabled !== undefined && before.enabled !== body.enabled) await audit(body.enabled ? "cql.enabled" : "cql.disabled");
    if (body.emailTitles !== undefined && before.emailTitles !== body.emailTitles) {
      await audit(body.emailTitles ? "cql.email_titles_on" : "cql.email_titles_off");
    }
    return success({
      enabled: body.enabled ?? before.enabled,
      emailTitles: body.emailTitles ?? before.emailTitles,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
