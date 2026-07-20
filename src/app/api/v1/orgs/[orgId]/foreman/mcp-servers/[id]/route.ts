import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError } from "@/lib/api-helpers";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";

/**
 * Update/delete a single Foreman MCP server by id — sibling of
 * foreman/mcp-servers/route.ts (list+create). Scoped to rows the caller's
 * org can manage: this org's own servers (`orgId` = this org) or
 * project-wide servers (`orgId: null`), same visibility set as the list GET.
 *
 * IMPORTANT: the row's scope is looked up FIRST via a plain `findUnique({where:{id}})`
 * and the org-vs-project authorization check is applied in app code — never
 * `OR:[{orgId:null},{orgId}]` inside the mutate `where`, since that would let
 * a caller's own-org membership satisfy the `where` for a DIFFERENT org's row
 * (the `id` alone is globally unique) — a cross-tenant priv-esc bug fixed in
 * the sibling skills route.
 */
type RouteParams = { params: Promise<{ orgId: string; id: string }> };

async function gate(
  params: RouteParams["params"],
): Promise<{ orgId: string; id: string } | { error: Response }> {
  const { orgId, id } = await params;
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { id: true, slug: true },
  });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  requirePermission(ctx, Permission.ORG_MANAGE_SETTINGS);
  return { orgId, id };
}

const patchSchema = z.object({
  enabled: z.boolean().optional(),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const g = await gate(params);
    if ("error" in g) return g.error;
    const data = patchSchema.parse(await request.json());

    const row = await prisma.foremanMcpServer.findUnique({ where: { id: g.id }, select: { orgId: true } });
    // Another org's server is invisible ⇒ 404. A PROJECT-WIDE server (orgId null) is
    // wired into EVERY org's build agents, so only a platform admin may change it —
    // never a single tenant's org admin.
    if (!row || (row.orgId !== null && row.orgId !== g.orgId)) return new Response("Not found", { status: 404 });
    if (row.orgId === null && !(await requireSystemAdmin())) {
      return new Response("Project-wide MCP servers can only be changed by a platform admin", {
        status: 403,
      });
    }

    const updated = await prisma.foremanMcpServer.update({
      where: { id: g.id },
      data: {
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      },
      select: { id: true, orgId: true, name: true, url: true, enabled: true },
    });
    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const g = await gate(params);
    if ("error" in g) return g.error;

    const row = await prisma.foremanMcpServer.findUnique({ where: { id: g.id }, select: { orgId: true } });
    // Another org's server is invisible ⇒ 404. A PROJECT-WIDE server (orgId null) is
    // wired into EVERY org's build agents, so only a platform admin may change it —
    // never a single tenant's org admin.
    if (!row || (row.orgId !== null && row.orgId !== g.orgId)) return new Response("Not found", { status: 404 });
    if (row.orgId === null && !(await requireSystemAdmin())) {
      return new Response("Project-wide MCP servers can only be changed by a platform admin", {
        status: 403,
      });
    }

    await prisma.foremanMcpServer.delete({ where: { id: g.id } });
    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
