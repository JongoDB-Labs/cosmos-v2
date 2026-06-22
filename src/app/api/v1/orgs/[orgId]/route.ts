import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress, noContent } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { revalidateOrg } from "@/lib/cache/queries";
import { isReservedSlug } from "@/lib/org/reserved-slugs";
import { logoUrlSchema } from "@/lib/security/image-url";
import { z } from "zod";

export const updateOrgSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  // Renaming the slug changes the workspace URL — same format rules as
  // creation. Uniqueness + reserved-word checks happen below.
  slug: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  logoUrl: logoUrlSchema,
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

    // Slug rename: validate it's free and not a reserved route segment before
    // we change the workspace URL. Only act when it actually differs.
    const slugChanged = data.slug !== undefined && data.slug !== org.slug;
    if (slugChanged) {
      const slug = data.slug!;
      if (isReservedSlug(slug)) {
        return Response.json(
          { error: "That URL is reserved. Pick a different one." },
          { status: 409 },
        );
      }
      const taken = await prisma.organization.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (taken && taken.id !== orgId) {
        return Response.json(
          { error: "That URL is already taken." },
          { status: 409 },
        );
      }
    }

    const updated = await prisma.organization.update({
      where: { id: orgId },
      data: {
        name: data.name,
        slug: slugChanged ? data.slug : undefined,
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
    // updates on next render. On a slug rename, expire BOTH the old and new
    // slug tags — getOrgBySlug is keyed on the slug.
    revalidateOrg({ id: orgId, slug: org.slug });
    if (slugChanged) revalidateOrg({ slug: data.slug });

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

    // Defense-in-depth against an accidental/forged delete: the caller must
    // echo the exact org name (the UI requires typing it). Origin-CSRF is
    // already enforced in middleware; this is the second, intentional gate.
    const body = await request.json().catch(() => ({}));
    const confirmName =
      body && typeof body === "object" ? (body as { confirmName?: unknown }).confirmName : undefined;
    if (confirmName !== org.name) {
      return Response.json(
        { error: "Type the organization name exactly to confirm deletion." },
        { status: 400 },
      );
    }

    // Snapshot for the audit trail BEFORE the cascade wipes the membership.
    const memberCount = await prisma.orgMember.count({ where: { orgId } });

    // Hard delete cascades every org-scoped row. AuditLog has no FK to the org
    // (scalar orgId), so this record survives the deletion as the tombstone.
    await prisma.organization.delete({ where: { id: orgId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "org.deleted",
      entity: "organization",
      entityId: orgId,
      metadata: {
        name: org.name,
        slug: org.slug,
        plan: org.plan,
        memberCount,
      },
      ipAddress: getIpAddress(request),
    });

    revalidateOrg({ id: orgId, slug: org.slug });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
