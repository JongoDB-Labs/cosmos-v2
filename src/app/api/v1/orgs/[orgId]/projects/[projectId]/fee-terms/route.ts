import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { financeSettings, resolveMarkup, MAX_MARKUP_PCT } from "@/lib/finance/markup";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/**
 * A project's fee terms: today, its markup on reimbursable costs, which
 * overrides the org's default for every bill on the project that doesn't set
 * its own (src/lib/finance/markup.ts).
 *
 * GET  with FINANCE_READ on a project the caller can see.
 * PUT  with FINANCE_MANAGE on a project the caller can see; audited.
 *
 * Both through requireProjectRead: the bit (and any ABAC policy) for this
 * project, then its visibility, which is scoped to the org, so another org's
 * project is refused before anything is read or written against its id.
 */
async function load(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, settings: true } });
  if (!org) return { org: null, ctx: null };
  return { org, ctx: await getAuthContext(org.slug) };
}

const putSchema = z.strictObject({
  markupPct: z.number().finite().min(0).max(MAX_MARKUP_PCT).nullable(),
});

function terms(markupPct: { toString(): string } | null | undefined, orgSettings: unknown) {
  const own = markupPct === null || markupPct === undefined ? null : Number(markupPct);
  const { pct, source } = resolveMarkup({ project: own, org: financeSettings(orgSettings).reimbursableMarkupPct });
  return { markupPct: own, effectiveMarkup: { pct, source: source as "project" | "org" } };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { org, ctx } = await load(orgId);
    if (!org) return new Response("Not found", { status: 404 });
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "FINANCE_READ");

    const row = await prisma.projectFeeTerms.findUnique({ where: { projectId }, select: { markupPct: true } });
    return success({
      ...terms(row?.markupPct, org.settings),
      canManage: hasPermission(ctx.permissions, Permission.FINANCE_MANAGE),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { org, ctx } = await load(orgId);
    if (!org) return new Response("Not found", { status: 404 });
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    await requireProjectRead(ctx, projectId, "FINANCE_MANAGE");

    const { markupPct } = putSchema.parse(await request.json());
    const before = await prisma.projectFeeTerms.findUnique({ where: { projectId }, select: { markupPct: true } });
    const row = await prisma.projectFeeTerms.upsert({
      where: { projectId },
      create: { projectId, markupPct },
      update: { markupPct },
      select: { markupPct: true },
    });
    await logAudit({
      orgId: org.id,
      userId: ctx.userId,
      action: "project.fee_terms_updated",
      entity: "project",
      entityId: projectId,
      metadata: {
        before: before?.markupPct == null ? "org default" : `${Number(before.markupPct)}%`,
        after: row.markupPct === null ? "org default" : `${Number(row.markupPct)}%`,
      },
      ipAddress: getIpAddress(request),
    });
    return success(terms(row.markupPct, org.settings));
  } catch (error) {
    return handleApiError(error);
  }
}
