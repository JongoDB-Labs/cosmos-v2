import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { getEntitlements, isSectorEnabled } from "@/lib/entitlements";
import { PluginRegistry } from "@/lib/plugins/registry";
import "@/lib/plugins/registry/server";

// Settings → Plugins listing (ADR 0003): the registered plugin catalog joined with
// this org's OrgPluginState rows + sector compatibility. Tenant-admin surface gated
// by PLUGIN_MANAGE. Icons are NOT serialized — the panel resolves them client-side
// from the client-safe manifest registry, keyed by slug.

type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, slug: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PLUGIN_MANAGE);

    const [rows, entitlements] = await Promise.all([
      prisma.orgPluginState.findMany({ where: { orgId } }),
      getEntitlements(orgId),
    ]);
    const stateBySlug = new Map(rows.map((r) => [r.pluginSlug, r]));

    const plugins = PluginRegistry.getAll().map((m) => {
      const state = stateBySlug.get(m.slug);
      const sectorCompatible =
        !m.sectors || m.sectors.length === 0
          ? true
          : m.sectors.some((s) => isSectorEnabled(entitlements, s));
      return {
        slug: m.slug,
        name: m.name,
        description: m.description,
        version: m.version,
        minCosmosVersion: m.minCosmosVersion ?? null,
        sectors: m.sectors ?? [],
        modules: m.modules.map((mod) => ({ key: mod.key, label: mod.label })),
        configFields: m.configFields ?? [],
        recommendedSkinId: m.recommendedSkinId ?? null,
        sectorCompatible,
        enabled: state?.enabled === true,
        config: (state?.config ?? {}) as Record<string, unknown>,
        enabledAt: state?.enabledAt?.toISOString() ?? null,
        enabledVersion: state?.enabledVersion ?? null,
      };
    });

    return success({ plugins });
  } catch (error) {
    return handleApiError(error);
  }
}
