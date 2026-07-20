import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError } from "@/lib/api-helpers";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";

/**
 * Update/delete a single Foreman skill by id — sibling of
 * foreman/skills/route.ts (list+create). Scoped to rows the caller's org can
 * manage: this org's own skills (`orgId` = this org) or project-wide skills
 * (`orgId: null`), same visibility set as the list GET.
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
  description: z.string().optional(),
  body: z.string().optional(),
});

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const g = await gate(params);
    if ("error" in g) return g.error;
    const data = patchSchema.parse(await request.json());

    const skill = await prisma.foremanSkill.findUnique({ where: { id: g.id }, select: { orgId: true } });
    // Another org's skill is invisible ⇒ 404. A PROJECT-WIDE skill (orgId null) is
    // injected into EVERY org's build agents, so only a platform admin may change it —
    // never a single tenant's org admin.
    if (!skill || (skill.orgId !== null && skill.orgId !== g.orgId)) return new Response("Not found", { status: 404 });
    if (skill.orgId === null && !(await requireSystemAdmin())) {
      return new Response("Project-wide skills can only be changed by a platform admin", { status: 403 });
    }

    const updated = await prisma.foremanSkill.update({
      where: { id: g.id },
      data: {
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.body !== undefined ? { body: data.body } : {}),
      },
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

    const skill = await prisma.foremanSkill.findUnique({ where: { id: g.id }, select: { orgId: true } });
    // Another org's skill is invisible ⇒ 404. A PROJECT-WIDE skill (orgId null) is
    // injected into EVERY org's build agents, so only a platform admin may change it —
    // never a single tenant's org admin.
    if (!skill || (skill.orgId !== null && skill.orgId !== g.orgId)) return new Response("Not found", { status: 404 });
    if (skill.orgId === null && !(await requireSystemAdmin())) {
      return new Response("Project-wide skills can only be changed by a platform admin", { status: 403 });
    }

    await prisma.foremanSkill.delete({ where: { id: g.id } });
    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
