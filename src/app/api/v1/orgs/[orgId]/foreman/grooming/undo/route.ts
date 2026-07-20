import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { undoGroomedAction } from "@/lib/foreman/grooming-actions";

/**
 * Reverse a supervisor LIVE action — the console per-row Undo button.
 * ORG_MANAGE_SETTINGS (steering privilege). The verdict was computed by the trusted
 * daemon; this re-executes it live and records a non-dry `groomed` event.
 */
type RouteParams = { params: Promise<{ orgId: string }> };
const bodySchema = z.object({ workItemId: z.string().uuid() });

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, slug: true } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);
    const { workItemId } = bodySchema.parse(await request.json());
    return success(await undoGroomedAction(orgId, workItemId, ctx.userId));
  } catch (error) {
    return handleApiError(error);
  }
}
