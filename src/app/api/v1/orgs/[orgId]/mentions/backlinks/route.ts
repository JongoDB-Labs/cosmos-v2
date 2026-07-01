import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { resolveBacklinks } from "@/lib/mentions/registry.server";
import { isEntityType } from "@/lib/mentions/refs";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * "Mentioned in …" — the sources (chat / comments / notes / work items) that
 * reference a target entity. `?type=<entityType>&id=<uuid>`.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, slug: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_READ);

    const sp = request.nextUrl.searchParams;
    const type = sp.get("type");
    const id = sp.get("id");
    if (!isEntityType(type) || !id) return success([]);

    const backlinks = await resolveBacklinks({
      orgId: org.id,
      orgSlug: org.slug,
      userId: ctx.userId,
      targetType: type,
      targetId: id,
    });
    return success(backlinks);
  } catch (error) {
    return handleApiError(error);
  }
}
