import { prisma } from "@/lib/db/client";
import { getBrand } from "@/lib/brand";
import { ForbiddenError } from "@/lib/rbac/check";
import { PluginRegistry, PluginServerRegistry } from "./registry";
// Side-effect import: the generated registry is what POPULATES those singletons.
// Without it PluginRegistry.get() is empty here, reconcilePluginVersion silently
// returns, and a deployed plugin upgrade reaches nobody — which is exactly how
// eight new SAFe roles shipped to prod and never appeared.
import "./registry/server";
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
  await reconcilePluginVersion(orgId, slug);
}

/**
 * Run a plugin's onUpgrade when the deployed manifest has moved past what this
 * org was last provisioned at.
 *
 * Without this, onUpgrade only ever fires from the Settings → Plugins PATCH —
 * i.e. when an admin happens to toggle something. Shipping a new plugin version
 * would therefore deliver its migrations-of-data (new roles, new seed rows) to
 * NOBODY until a human clicked, and the orgs already using the plugin are
 * exactly the ones that need them. Observed live: a release added eight SAFe
 * roles and the running instance still showed six.
 *
 * Idempotent and self-limiting: it stamps enabledVersion, so this runs at most
 * once per org per version and every subsequent request short-circuits on the
 * cheap equality check.
 */
export async function reconcilePluginVersion(orgId: string, slug: string): Promise<void> {
  const manifest = PluginRegistry.get(slug);
  if (!manifest?.version) return;

  const row = await prisma.orgPluginState.findUnique({
    where: { orgId_pluginSlug: { orgId, pluginSlug: slug } },
    select: { enabledVersion: true },
  });
  if (!row || row.enabledVersion === manifest.version) return;

  // Best-effort. A plugin whose upgrade hook throws must not take down every
  // request to that plugin — the version stays unstamped, so the next request
  // retries, and the failure is visible in logs rather than as a 500 storm.
  try {
    await PluginServerRegistry.get(slug)?.onUpgrade?.(prisma, orgId, row.enabledVersion);
    await prisma.orgPluginState.update({
      where: { orgId_pluginSlug: { orgId, pluginSlug: slug } },
      data: { enabledVersion: manifest.version },
    });
  } catch (e) {
    // Deliberately silent to the USER. This runs inside an unrelated request —
    // any plugin API call — so the person who triggered it did not ask for an
    // upgrade and can do nothing about a failure; surfacing it would turn a
    // background reconcile into an error on a page that otherwise worked. The
    // version stays unstamped so the next request retries, and operators see it
    // in the server log.
    // eslint-disable-next-line no-restricted-syntax -- background reconcile, see above
    console.error(
      `[plugins] onUpgrade failed for ${slug} in org ${orgId} ` +
        `(${row.enabledVersion} → ${manifest.version}):`,
      e,
    );
  }
}

/**
 * Fire onProjectCreate for every plugin enabled in the org, after a project is
 * created. Call it POST-COMMIT so the hook sees a persisted project it can query.
 *
 * Best-effort per plugin, for the same reason reconcilePluginVersion is: a plugin
 * hook must NEVER be able to fail core project creation. A throw is logged and
 * the next plugin still runs. Callers therefore need no try/catch of their own —
 * and must not skip creation on a plugin's behalf.
 */
export async function firePluginProjectCreate(orgId: string, projectId: string): Promise<void> {
  const slugs = await getEnabledPluginSlugs(orgId);
  for (const slug of slugs) {
    try {
      await PluginServerRegistry.get(slug)?.onProjectCreate?.(prisma, orgId, projectId);
    } catch (e) {
      // eslint-disable-next-line no-restricted-syntax -- best-effort plugin hook, must not fail project creation
      console.error(`[plugins] onProjectCreate failed for ${slug} in org ${orgId} (project ${projectId}):`, e);
    }
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
