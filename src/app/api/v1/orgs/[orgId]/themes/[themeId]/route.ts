import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, noContent, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

const REQUIRED_COLORS = [
  "background",
  "foreground",
  "surface",
  "border",
  "primary",
  "text",
] as const;

const updateThemeSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  mode: z.enum(["LIGHT", "DARK", "HIGH_CONTRAST"]).optional(),
  colors: z
    .record(z.string(), z.unknown())
    .refine(
      (c) => REQUIRED_COLORS.every((k) => k in c),
      `Colors must include: ${REQUIRED_COLORS.join(", ")}`,
    )
    .optional(),
  typography: z.record(z.string(), z.unknown()).optional(),
  spacing: z.record(z.string(), z.unknown()).optional(),
  branding: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

// PATCH allows partial color updates without requiring all 6 keys.
const patchThemeSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  mode: z.enum(["LIGHT", "DARK", "HIGH_CONTRAST"]).optional(),
  colors: z.record(z.string(), z.unknown()).optional(),
  typography: z.record(z.string(), z.unknown()).optional(),
  spacing: z.record(z.string(), z.unknown()).optional(),
  branding: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

type RouteParams = { params: Promise<{ orgId: string; themeId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, themeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.THEME_READ);

    const theme = await prisma.theme.findFirst({
      where: { id: themeId, OR: [{ orgId: null }, { orgId }] },
    });

    if (!theme) return new Response("Not found", { status: 404 });

    return success(theme);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, themeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.THEME_MANAGE);

    const theme = await prisma.theme.findFirst({
      where: { id: themeId, orgId },
    });
    if (!theme) return new Response("Not found", { status: 404 });

    if (theme.isBuiltIn) {
      return new Response(
        JSON.stringify({ error: "Cannot modify built-in themes" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json();
    const data = updateThemeSchema.parse(body);

    const updated = await prisma.theme.update({
      where: { id: themeId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.mode !== undefined ? { mode: data.mode } : {}),
        ...(data.colors !== undefined
          ? { colors: data.colors as Prisma.InputJsonValue }
          : {}),
        ...(data.typography !== undefined
          ? { typography: data.typography as Prisma.InputJsonValue }
          : {}),
        ...(data.spacing !== undefined
          ? { spacing: data.spacing as Prisma.InputJsonValue }
          : {}),
        ...(data.branding !== undefined
          ? { branding: data.branding as Prisma.InputJsonValue }
          : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "theme.updated",
      entity: "theme",
      entityId: themeId,
      metadata: { name: updated.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, themeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.THEME_MANAGE);

    const theme = await prisma.theme.findFirst({
      where: { id: themeId, orgId },
    });
    if (!theme) return new Response("Not found", { status: 404 });

    if (theme.isBuiltIn) {
      return new Response(
        JSON.stringify({ error: "Cannot modify built-in themes" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    const body = await request.json();
    const data = patchThemeSchema.parse(body);

    const updated = await prisma.theme.update({
      where: { id: themeId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.mode !== undefined && { mode: data.mode }),
        ...(data.colors !== undefined && {
          colors: data.colors as Prisma.InputJsonValue,
        }),
        ...(data.typography !== undefined && {
          typography: data.typography as Prisma.InputJsonValue,
        }),
        ...(data.spacing !== undefined && {
          spacing: data.spacing as Prisma.InputJsonValue,
        }),
        ...(data.branding !== undefined && {
          branding: data.branding as Prisma.InputJsonValue,
        }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "theme.patched",
      entity: "theme",
      entityId: themeId,
      metadata: { name: updated.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, themeId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.THEME_MANAGE);

    const theme = await prisma.theme.findFirst({
      where: { id: themeId, orgId },
    });
    if (!theme) return new Response("Not found", { status: 404 });

    if (theme.isBuiltIn) {
      return new Response(
        JSON.stringify({ error: "Cannot delete built-in themes" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    await prisma.theme.delete({ where: { id: themeId } });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "theme.deleted",
      entity: "theme",
      entityId: themeId,
      metadata: { name: theme.name } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return noContent();
  } catch (error) {
    return handleApiError(error);
  }
}
