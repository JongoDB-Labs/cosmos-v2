import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { workflowSettings } from "@/lib/workflow/settings";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * The org's workflow settings (src/lib/workflow/settings.ts).
 *
 * GET  the settings and whether the caller may change them, for anyone who
 *      reads items (the transition prompt offers the resolutions).
 * PUT  a partial update with WORKFLOW_MANAGE; audited.
 */
async function load(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true, settings: true } });
  if (!org) return { org: null, ctx: null };
  return { org, ctx: await getAuthContext(org.slug) };
}

const putSchema = z.strictObject({
  blockParentWithOpenChildren: z.boolean().optional(),
  resolutions: z.array(z.string().trim().min(1).max(60)).min(1).max(30).optional(),
});

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { org, ctx } = await load((await params).orgId);
    if (!org) return new Response("Not found", { status: 404 });
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ITEM_READ);
    return success({ ...workflowSettings(org.settings), canManage: hasPermission(ctx.permissions, Permission.WORKFLOW_MANAGE) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { org, ctx } = await load((await params).orgId);
    if (!org) return new Response("Not found", { status: 404 });
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.WORKFLOW_MANAGE);

    const patch = putSchema.parse(await request.json());
    const before = workflowSettings(org.settings);
    // Merged in one statement, so a concurrent change to any other org setting
    // (or another workflow key) is not overwritten by a stale read.
    const [row] = await prisma.$queryRaw<{ settings: unknown }[]>`
      UPDATE organizations
      SET settings = jsonb_set(
        COALESCE(settings, '{}'::jsonb), '{workflow}',
        COALESCE(settings->'workflow', '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
      )
      WHERE id = ${org.id}::uuid
      RETURNING settings
    `;
    const after = workflowSettings(row?.settings);
    await logAudit({
      orgId: org.id,
      userId: ctx.userId,
      action: "workflow.settings_updated",
      entity: "organization",
      entityId: org.id,
      metadata: {
        changes: Object.keys(patch).join(", "),
        ...(patch.blockParentWithOpenChildren !== undefined && {
          blockParentWithOpenChildren: `${before.blockParentWithOpenChildren} -> ${after.blockParentWithOpenChildren}`,
        }),
      },
      ipAddress: getIpAddress(request),
    });
    return success(after);
  } catch (error) {
    return handleApiError(error);
  }
}
