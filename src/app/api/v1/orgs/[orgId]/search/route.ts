import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { searchEntities } from "@/lib/mentions/registry.server";
import { ENTITY_ORDER } from "@/lib/mentions/refs";

type RouteParams = { params: Promise<{ orgId: string }> };

// ⌘K is now a GLOBAL search: it queries EVERY entity class the shared registry
// indexes (projects, work items, docs, OKRs, PM registers, CRM, …) rather than
// the original four. The palette consumes the registry's canonical `EntityType`
// directly, so no legacy string remapping is needed. Keep `perType` modest — a
// wide fan-out over many types must stay within the palette's latency budget.
const PALETTE_TYPES = ENTITY_ORDER;
const PER_TYPE = 6;

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

    const q = request.nextUrl.searchParams.get("q");
    if (!q || q.trim().length === 0) {
      return success([]);
    }

    const hits = await searchEntities({
      orgId: org.id,
      orgSlug: org.slug,
      userId: ctx.userId,
      query: q,
      types: PALETTE_TYPES,
      perType: PER_TYPE,
    });

    // Flatten to the shape the command palette consumes: { id, type, name, url }.
    // People have no profile page (`entityUrl` → null) but are still a useful
    // search target, so fall back to the org's Team roster. Any other hit with
    // no deep-link (e.g. its owning project was deleted) is unnavigable → drop.
    const results = hits
      .map((h) => ({
        id: h.id,
        type: h.type,
        name: h.label,
        url: h.url ?? (h.type === "user" ? `/${org.slug}/team` : null),
      }))
      .filter((r): r is typeof r & { url: string } => r.url != null);
    return success(results);
  } catch (error) {
    return handleApiError(error);
  }
}
