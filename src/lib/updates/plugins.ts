import { prisma } from "@/lib/db/client";
import { PluginRegistry } from "@/lib/plugins/registry";
import { reconcilePluginVersion } from "@/lib/plugins/enablement";

/**
 * Which plugins are behind the version this image ships.
 *
 * NOT the same question as "is a newer image available". A plugin's CODE always
 * matches the image it was composed into — there is no such thing as an
 * out-of-date plugin binary here. What can lag is the per-org record of which
 * version last ran its onUpgrade, and that record is what core compares against
 * to decide whether to run it again.
 *
 * It lags for an ordinary reason: reconciliation happens on the read path, when
 * somebody touches that plugin's API. An org that has not opened a plugin since
 * the release simply has not reconciled yet, and one that never opens it never
 * will. That is fine for an idempotent seed and not fine for anything that has
 * to happen once.
 */

export interface PluginOrgVersion {
  orgId: string;
  orgName: string;
  enabledVersion: string | null;
  upToDate: boolean;
}

export interface PluginVersionStatus {
  slug: string;
  name: string;
  /** The version this image composed in. */
  deployedVersion: string | null;
  /** Enabled orgs whose stamp is behind the deployed version. */
  behind: PluginOrgVersion[];
  /** Enabled orgs already at it. */
  current: PluginOrgVersion[];
}

export async function pluginVersionStatus(): Promise<PluginVersionStatus[]> {
  const manifests = PluginRegistry.getAll();
  if (manifests.length === 0) return [];

  const rows = await prisma.orgPluginState.findMany({
    where: { enabled: true, pluginSlug: { in: manifests.map((m) => m.slug) } },
    select: {
      orgId: true,
      pluginSlug: true,
      enabledVersion: true,
      org: { select: { name: true } },
    },
  });

  return manifests
    .map((m) => {
      const mine = rows.filter((r) => r.pluginSlug === m.slug);
      const split = (upToDate: boolean) =>
        mine
          .filter((r) => (r.enabledVersion === m.version) === upToDate)
          .map((r) => ({
            orgId: r.orgId,
            orgName: r.org.name,
            enabledVersion: r.enabledVersion,
            upToDate,
          }));
      return {
        slug: m.slug,
        name: m.name ?? m.slug,
        deployedVersion: m.version ?? null,
        behind: split(false),
        current: split(true),
      };
    })
    .sort((a, b) => b.behind.length - a.behind.length || a.slug.localeCompare(b.slug));
}

export interface PluginReconcileResult {
  slug: string;
  attempted: number;
  /** Orgs now stamped at the deployed version. */
  reconciled: number;
  /** Orgs still behind — their onUpgrade threw and was logged. */
  failed: { orgId: string; orgName: string }[];
}

/**
 * Run the upgrade hook for every enabled org of one plugin, now, instead of
 * waiting for somebody to open the plugin.
 *
 * Uses the SAME reconcile the read path uses, deliberately: a second code path
 * that upgrades differently is a second set of bugs, and this one is already
 * idempotent and already self-limiting. Calling it for an org that is current
 * costs one indexed read.
 *
 * Failures are counted, not thrown. One org whose hook throws must not stop the
 * rest — and the caller wants to know WHICH, which an exception cannot say.
 */
export async function reconcilePluginForAllOrgs(slug: string): Promise<PluginReconcileResult> {
  const manifest = PluginRegistry.get(slug);
  if (!manifest) throw new Error(`Unknown plugin: ${slug}`);

  const orgs = await prisma.orgPluginState.findMany({
    where: { pluginSlug: slug, enabled: true },
    select: { orgId: true, org: { select: { name: true } } },
  });

  for (const o of orgs) await reconcilePluginVersion(o.orgId, slug);

  // Re-read rather than trusting the loop: reconcile swallows a failing hook by
  // design (it runs inside unrelated requests), so the only honest report of
  // what actually moved is the stamp itself.
  const after = await prisma.orgPluginState.findMany({
    where: { pluginSlug: slug, enabled: true },
    select: { orgId: true, enabledVersion: true, org: { select: { name: true } } },
  });
  const failed = after
    .filter((r) => r.enabledVersion !== manifest.version)
    .map((r) => ({ orgId: r.orgId, orgName: r.org.name }));

  return {
    slug,
    attempted: orgs.length,
    reconciled: after.length - failed.length,
    failed,
  };
}
