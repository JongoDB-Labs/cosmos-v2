import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { logAudit } from "@/lib/audit";
import { getEntitlements, isSectorEnabled } from "@/lib/entitlements";
import { PluginRegistry, PluginServerRegistry } from "@/lib/plugins/registry";
import "@/lib/plugins/registry/server";

// Enable/disable/configure one plugin for one org (ADR 0003).
//   enabled:true  → sector-compat check (400), upsert, run onFirstEnable (first time)
//                   or onUpgrade (manifest version moved), stamp version/by/at.
//   enabled:false → flip the flag ONLY — row, config, and all plugin domain data are
//                   retained so re-enabling restores everything.
//   config        → validated against the plugin's zod configSchema (400 on failure).

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type RouteParams = { params: Promise<{ orgId: string; slug: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, slug } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, slug: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PLUGIN_MANAGE);

    const manifest = PluginRegistry.get(slug);
    if (!manifest) return new Response("Not found", { status: 404 });
    const hooks = PluginServerRegistry.get(slug);

    const data = patchSchema.parse(await request.json());

    // Validate config against the plugin's own schema before writing anything.
    let configUpdate: Record<string, unknown> | undefined;
    if (data.config !== undefined) {
      if (hooks?.configSchema) {
        const parsed = hooks.configSchema.safeParse(data.config);
        if (!parsed.success) {
          return NextResponse.json(
            { error: `Invalid config: ${parsed.error.issues.map((i) => i.message).join("; ")}` },
            { status: 400 },
          );
        }
        configUpdate = parsed.data;
      } else {
        configUpdate = data.config;
      }
    }

    const existing = await prisma.orgPluginState.findUnique({
      where: { orgId_pluginSlug: { orgId, pluginSlug: slug } },
    });

    let action: "plugin.enabled" | "plugin.disabled" | "plugin.config_updated" =
      "plugin.config_updated";

    if (data.enabled === true) {
      // Sector gate — enforced at enable time, server-side.
      if (manifest.sectors && manifest.sectors.length > 0) {
        const entitlements = await getEntitlements(orgId);
        if (!manifest.sectors.some((s) => isSectorEnabled(entitlements, s))) {
          return NextResponse.json(
            {
              error: `Plugin "${slug}" requires sector(s) ${manifest.sectors.join(", ")} which are not enabled for this organization`,
            },
            { status: 400 },
          );
        }
      }
      action = "plugin.enabled";
    } else if (data.enabled === false) {
      action = "plugin.disabled";
    }

    const row = await prisma.orgPluginState.upsert({
      where: { orgId_pluginSlug: { orgId, pluginSlug: slug } },
      create: {
        orgId,
        pluginSlug: slug,
        enabled: data.enabled === true,
        ...(configUpdate !== undefined && { config: configUpdate as object }),
        ...(data.enabled === true && {
          enabledVersion: manifest.version,
          enabledAt: new Date(),
          enabledById: ctx.userId,
        }),
      },
      update: {
        ...(data.enabled !== undefined && { enabled: data.enabled }),
        ...(configUpdate !== undefined && { config: configUpdate as object }),
        ...(data.enabled === true && {
          enabledVersion: manifest.version,
          enabledAt: new Date(),
          enabledById: ctx.userId,
        }),
      },
    });

    // Provisioning hooks — first enable vs version upgrade (never on disable).
    if (data.enabled === true) {
      if (!existing?.enabledVersion) {
        await hooks?.onFirstEnable?.(prisma, orgId);
      } else if (existing.enabledVersion !== manifest.version) {
        await hooks?.onUpgrade?.(prisma, orgId, existing.enabledVersion);
      }
    }

    await logAudit({
      orgId,
      userId: ctx.userId,
      action,
      entity: "org_plugin_state",
      entityId: row.id,
      metadata: { plugin: slug, version: manifest.version } as Record<string, string>,
      ipAddress: getIpAddress(request),
    });

    return success({
      slug,
      enabled: row.enabled,
      config: row.config as Record<string, unknown>,
      enabledVersion: row.enabledVersion,
      enabledAt: row.enabledAt?.toISOString() ?? null,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
