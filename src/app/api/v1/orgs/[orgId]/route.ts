import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress, noContent } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { revalidateOrg } from "@/lib/cache/queries";
import { z } from "zod";

const updateOrgSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  logoUrl: z.string().url().nullable().optional(),
  themePrimary: z.string().nullable().optional(),
  themeMode: z.string().nullable().optional(),
  settings: z.record(z.string(), z.any()).optional(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    // NOTE: OrgMember.permissions is BigInt and breaks JSON.stringify in the
    // response helper, so we project members through a select that excludes it.
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      include: {
        members: {
          select: {
            id: true,
            role: true,
            joinedAt: true,
            user: {
              select: { id: true, email: true, displayName: true, avatarUrl: true },
            },
          },
        },
        projects: {
          where: { archived: false },
          select: { id: true, name: true, key: true },
        },
      },
    });

    if (!org) return new Response("Not found", { status: 404 });

    return success(org);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_UPDATE);

    const body = await request.json();
    const data = updateOrgSchema.parse(body);

    const updated = await prisma.organization.update({
      where: { id: orgId },
      data: {
        name: data.name,
        logoUrl: data.logoUrl,
        themePrimary: data.themePrimary,
        themeMode: data.themeMode,
        settings: data.settings as Record<string, string> | undefined,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "org.updated",
      entity: "organization",
      entityId: orgId,
      metadata: data as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    // Bust the cached org row (name/plan/theme) so dashboard headers see
    // updates on next render.
    revalidateOrg({ id: orgId, slug: org.slug });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_DELETE);

    await prisma.organization.delete({ where: { id: orgId } });

    revalidateOrg({ id: orgId, slug: org.slug });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
