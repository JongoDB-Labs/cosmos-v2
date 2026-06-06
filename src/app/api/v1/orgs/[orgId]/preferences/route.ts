import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { z } from "zod";

const updatePreferencesSchema = z.object({
  themeId: z.string().uuid().nullable().optional(),
  themeMode: z.enum(["LIGHT", "DARK"]).nullable().optional(),
  sidebarPosition: z.enum(["LEFT", "RIGHT"]).optional(),
  navigationStyle: z.enum(["TABS", "BREADCRUMBS", "BOTH"]).optional(),
  density: z.enum(["COMPACT", "COMFORTABLE", "SPACIOUS"]).optional(),
  defaultBoardId: z.string().uuid().nullable().optional(),
  methodology: z.string().max(50).nullable().optional(),
  bgDarkUrl: z.string().nullable().optional(),
  bgLightUrl: z.string().nullable().optional(),
  // Do Not Disturb / quiet-hours fields
  dndEnabled: z.boolean().optional(),
  dndStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  dndEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  dndTimezone: z.string().max(50).nullable().optional(),
});

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });

    const preferences = await prisma.userPreferences.upsert({
      where: { userId: ctx.userId },
      create: {
        userId: ctx.userId,
        sidebarPosition: "LEFT",
        navigationStyle: "BOTH",
        density: "COMFORTABLE",
      },
      update: {},
    });

    return success(preferences);
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

    const body = await request.json();
    const data = updatePreferencesSchema.parse(body);

    const preferences = await prisma.userPreferences.upsert({
      where: { userId: ctx.userId },
      create: {
        userId: ctx.userId,
        sidebarPosition: data.sidebarPosition ?? "LEFT",
        navigationStyle: data.navigationStyle ?? "BOTH",
        density: data.density ?? "COMFORTABLE",
        ...(data.themeId !== undefined ? { themeId: data.themeId } : {}),
        ...(data.themeMode !== undefined ? { themeMode: data.themeMode } : {}),
        ...(data.defaultBoardId !== undefined ? { defaultBoardId: data.defaultBoardId } : {}),
        ...(data.methodology !== undefined ? { methodology: data.methodology } : {}),
        ...(data.bgDarkUrl !== undefined ? { bgDarkUrl: data.bgDarkUrl } : {}),
        ...(data.bgLightUrl !== undefined ? { bgLightUrl: data.bgLightUrl } : {}),
        ...(data.dndEnabled !== undefined ? { dndEnabled: data.dndEnabled } : {}),
        ...(data.dndStart !== undefined ? { dndStart: data.dndStart } : {}),
        ...(data.dndEnd !== undefined ? { dndEnd: data.dndEnd } : {}),
        ...(data.dndTimezone !== undefined ? { dndTimezone: data.dndTimezone } : {}),
      },
      update: {
        ...(data.themeId !== undefined ? { themeId: data.themeId } : {}),
        ...(data.themeMode !== undefined ? { themeMode: data.themeMode } : {}),
        ...(data.sidebarPosition !== undefined ? { sidebarPosition: data.sidebarPosition } : {}),
        ...(data.navigationStyle !== undefined ? { navigationStyle: data.navigationStyle } : {}),
        ...(data.density !== undefined ? { density: data.density } : {}),
        ...(data.defaultBoardId !== undefined ? { defaultBoardId: data.defaultBoardId } : {}),
        ...(data.methodology !== undefined ? { methodology: data.methodology } : {}),
        ...(data.bgDarkUrl !== undefined ? { bgDarkUrl: data.bgDarkUrl } : {}),
        ...(data.bgLightUrl !== undefined ? { bgLightUrl: data.bgLightUrl } : {}),
        ...(data.dndEnabled !== undefined ? { dndEnabled: data.dndEnabled } : {}),
        ...(data.dndStart !== undefined ? { dndStart: data.dndStart } : {}),
        ...(data.dndEnd !== undefined ? { dndEnd: data.dndEnd } : {}),
        ...(data.dndTimezone !== undefined ? { dndTimezone: data.dndTimezone } : {}),
      },
    });

    await logAudit({
      orgId,
      userId: ctx.userId,
      action: "preferences.updated",
      entity: "user_preferences",
      entityId: preferences.id,
      ipAddress: getIpAddress(request),
    });

    return success(preferences);
  } catch (error) {
    return handleApiError(error);
  }
}
