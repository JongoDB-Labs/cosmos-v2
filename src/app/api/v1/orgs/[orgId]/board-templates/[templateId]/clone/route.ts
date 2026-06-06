import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { cloneBoardTemplate } from "@/lib/templates/clone";
import { z } from "zod";

const cloneSchema = z.object({
  name: z.string().min(1).max(100),
});

type RouteParams = { params: Promise<{ orgId: string; templateId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, templateId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_MANAGE_TEMPLATES);

    const source = await prisma.boardTemplate.findUnique({ where: { id: templateId } });
    if (!source) return new Response("Not found", { status: 404 });

    // Only allow cloning built-in templates or org-owned templates
    if (!source.isBuiltIn && source.orgId !== orgId) {
      return new Response("Not found", { status: 404 });
    }

    const body = await request.json();
    const data = cloneSchema.parse(body);

    const newTemplateId = await cloneBoardTemplate(templateId, orgId, data.name);

    const newTemplate = await prisma.boardTemplate.findUnique({
      where: { id: newTemplateId },
      include: {
        widgets: true,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "board_template.cloned",
      entity: "board_template",
      entityId: newTemplateId,
      metadata: {
        name: data.name,
        sourceTemplateId: templateId,
        sourceTemplateName: source.name,
      } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(newTemplate);
  } catch (error) {
    return handleApiError(error);
  }
}
