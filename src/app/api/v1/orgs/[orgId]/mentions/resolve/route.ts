import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { resolveRefs } from "@/lib/mentions/registry.server";
import { isEntityType, type EntityRef } from "@/lib/mentions/refs";

type RouteParams = { params: Promise<{ orgId: string }> };

/**
 * Batch-resolve stored `<@type:id>` tokens to `{ type, id, label, url }` for
 * chip rendering. Body: `{ refs: [{ type, id }] }`. Permission/visibility
 * filtering happens in the registry — unresolved refs simply don't come back
 * (the chip then renders as a non-linking fallback label).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
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

    const body = (await request.json().catch(() => ({}))) as {
      refs?: Array<{ type?: unknown; id?: unknown }>;
    };
    const refs: EntityRef[] = (Array.isArray(body.refs) ? body.refs : [])
      .map((r) =>
        r && typeof r.id === "string" && isEntityType(r.type)
          ? ({ type: r.type, id: r.id } as EntityRef)
          : null,
      )
      .filter((r): r is EntityRef => r !== null)
      .slice(0, 200);

    const hits = await resolveRefs({
      orgId: org.id,
      orgSlug: org.slug,
      userId: ctx.userId,
      refs,
    });
    return success(hits);
  } catch (error) {
    return handleApiError(error);
  }
}
