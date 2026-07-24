import { prisma } from "@/lib/db/client";
import { getBrand } from "@/lib/brand";
import { ForbiddenError } from "@/lib/rbac/check";
import { PluginRegistry, PluginServerRegistry } from "./registry";
import { resolveDefaultPlugins } from "./default-env";

/**
 * Plugin enablement reads/guards (ADR 0003). FAIL-CLOSED: the absence of an
 * OrgPluginState row — or enabled=false — means OFF. Mirrors the style of
 * src/lib/entitlements/index.ts but deliberately not its null=all default.
 */

/** The set of plugin slugs explicitly enabled for an org. */
export async function getEnabledPluginSlugs(orgId: string): Promise<Set<string>> {
  const rows = await prisma.orgPluginState.findMany({
    where: { orgId, enabled: true },
    select: { pluginSlug: true },
  });
  return new Set(rows.map((r) => r.pluginSlug));
}

export async function isPluginEnabled(orgId: string, slug: string): Promise<boolean> {
  const row = await prisma.orgPluginState.findUnique({
    where: { orgId_pluginSlug: { orgId, pluginSlug: slug } },
    select: { enabled: true },
  });
  return row?.enabled === true;
}

/** Guard for plugin API handlers — 403s through handleApiError when disabled. */
export async function requirePluginEnabled(orgId: string, slug: string): Promise<void> {
  if (!(await isPluginEnabled(orgId, slug))) {
    throw new ForbiddenError(`Plugin "${slug}" is not enabled for this organization`);
  }
}

/** The org's per-plugin config blob ({} when unset/disabled). Callers own defaults. */
export async function getPluginConfig(orgId: string, slug: string): Promise<Record<string, unknown>> {
  const row = await prisma.orgPluginState.findUnique({
    where: { orgId_pluginSlug: { orgId, pluginSlug: slug } },
    select: { enabled: true, config: true },
  });
  if (!row?.enabled) return {};
  return (row.config ?? {}) as Record<string, unknown>;
}

/**
 * Batch-load enabled plugin slugs for the nav. Returns orgId → string[]
 * (absence ⇒ [] — fail-closed). Serializable, so it crosses the RSC→client
 * boundary in orgs[] exactly like getEnabledModulesByOrg's payload.
 */
export async function getEnabledPluginsByOrg(
  orgIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>(orgIds.map((id) => [id, []]));
  if (orgIds.length === 0) return map;
  const rows = await prisma.orgPluginState.findMany({
    where: { orgId: { in: orgIds }, enabled: true },
    select: { orgId: true, pluginSlug: true },
  });
  for (const row of rows) {
    map.get(row.orgId)?.push(row.pluginSlug);
  }
  return map;
}

/**
 * Provision a NEW org's plugins from the active product profile (env
 * DEFAULT_ENABLED_PLUGINS overrides). Runs each plugin's onFirstEnable and
 * stamps enabledVersion — identical outcome to an admin enabling it in
 * Settings → Plugins. No-op when the resolution is empty (cosmos default).
 */
export async function provisionPlugins(orgId: string, userId?: string): Promise<void> {
  const registered = PluginRegistry.getAll();
  const slugs = resolveDefaultPlugins(
    process.env.DEFAULT_ENABLED_PLUGINS,
    getBrand(),
    registered.map((m) => m.slug),
  );
  for (const slug of slugs) {
    const manifest = PluginRegistry.get(slug);
    if (!manifest) continue;
    const existing = await prisma.orgPluginState.findUnique({
      where: { orgId_pluginSlug: { orgId, pluginSlug: slug } },
    });
    if (existing?.enabled) continue;
    await prisma.orgPluginState.upsert({
      where: { orgId_pluginSlug: { orgId, pluginSlug: slug } },
      update: {
        enabled: true,
        enabledVersion: manifest.version,
        enabledAt: new Date(),
        enabledById: userId ?? null,
      },
      create: {
        orgId,
        pluginSlug: slug,
        enabled: true,
        enabledVersion: manifest.version,
        enabledAt: new Date(),
        enabledById: userId ?? null,
      },
    });
    if (!existing?.enabledVersion) {
      await PluginServerRegistry.get(slug)?.onFirstEnable?.(prisma, orgId);
    }
  }
}
