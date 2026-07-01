import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { searchEntities } from "@/lib/mentions/registry.server";
import { isEntityType, type EntityType } from "@/lib/mentions/refs";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * @-mention typeahead source. Shares `searchEntities` with the ⌘K palette so
 * both draw from one entity index. `?q=` term, optional `?types=a,b,c` filter,
 * optional `?perType=`.
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
    const q = sp.get("q") ?? "";
    const typesParam = sp.get("types");
    const types: EntityType[] | undefined = typesParam
      ? typesParam.split(",").map((s) => s.trim()).filter(isEntityType)
      : undefined;
    const perType = Math.min(Math.max(Number(sp.get("perType")) || 6, 1), 15);

    const hits = await searchEntities({
      orgId: org.id,
      orgSlug: org.slug,
      userId: ctx.userId,
      query: q,
      types,
      perType,
    });
    return success(hits);
  } catch (error) {
    return handleApiError(error);
  }
}
