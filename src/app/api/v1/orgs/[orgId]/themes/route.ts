import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { builtInThemes } from "@/lib/theme/built-in-themes";
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

const createThemeSchema = z.object({
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  mode: z.enum(["LIGHT", "DARK", "HIGH_CONTRAST"]),
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
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.THEME_READ);

    const dbThemes = await prisma.theme.findMany({
      where: { orgId },
      orderBy: { createdAt: "desc" },
    });

    const builtIn = builtInThemes.map((t) => ({
      id: `built-in-${t.slug}`,
      orgId: null,
      slug: t.slug,
      name: t.name,
      mode: t.mode,
      colors: t.colors,
      typography: {},
      spacing: {},
      branding: {},
      isBuiltIn: true,
      isActive: false,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    }));

    return success([...builtIn, ...dbThemes]);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.THEME_MANAGE);

    const body = await request.json();
    const data = createThemeSchema.parse(body);

    const theme = await prisma.theme.create({
      data: {
        orgId,
        slug: data.slug,
        name: data.name,
        mode: data.mode,
        colors: (data.colors ?? {}) as Prisma.InputJsonValue,
        typography: (data.typography ?? {}) as Prisma.InputJsonValue,
        spacing: (data.spacing ?? {}) as Prisma.InputJsonValue,
        branding: (data.branding ?? {}) as Prisma.InputJsonValue,
        isBuiltIn: false,
        isActive: false,
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "theme.created",
      entity: "theme",
      entityId: theme.id,
      metadata: { name: data.name, slug: data.slug } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return created(theme);
  } catch (error) {
    return handleApiError(error);
  }
}
