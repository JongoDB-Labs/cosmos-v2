import { prisma } from "@/lib/db/client";
import { getBrand } from "@/lib/brand";
import type { ProductProfile } from "@/lib/product/profiles";
import { FIXED_MODULES } from "./modules";
import { resolveDefaultEntitlements } from "./default-env";

/**
 * Resolved entitlements. `null` = "all enabled" (the load-bearing default that
 * preserves current behavior); a Set = the explicit allowlist of enabled keys.
 */
export type Entitlements = {
  enabledModules: Set<string> | null;
  enabledSectors: Set<string> | null;
};

export const DEFAULT_ENTITLEMENTS: Entitlements = {
  enabledModules: null,
  enabledSectors: null,
};

/** The persisted row shape (subset) the normalizer reads. */
export type EntitlementsRow = {
  moduleAllowlistEnabled: boolean;
  enabledModules: string[];
  sectorAllowlistEnabled: boolean;
  enabledSectors: string[];
};

/** Collapse a stored row to the clean `null = all` contract. Pure. */
export function normalizeEntitlements(row: EntitlementsRow): Entitlements {
  return {
    enabledModules: row.moduleAllowlistEnabled ? new Set(row.enabledModules) : null,
    enabledSectors: row.sectorAllowlistEnabled ? new Set(row.enabledSectors) : null,
  };
}

const FIXED = new Set<string>(FIXED_MODULES);

/** True if `key` is enabled. FIXED modules (overview/settings) are always on. Pure. */
export function isModuleEnabled(ent: Entitlements, key: string): boolean {
  if (FIXED.has(key)) return true;
  if (ent.enabledModules === null) return true;
  return ent.enabledModules.has(key);
}

/** True if industry sector `key` is enabled. Pure. */
export function isSectorEnabled(ent: Entitlements, key: string): boolean {
  if (ent.enabledSectors === null) return true;
  return ent.enabledSectors.has(key);
}

/**
 * Load an org's entitlements. A missing row ⇒ DEFAULT (all enabled), so existing
 * orgs are unaffected until a product/admin restricts something.
 */
export async function getEntitlements(orgId: string): Promise<Entitlements> {
  const row = await prisma.orgEntitlements.findUnique({ where: { orgId } });
  if (!row) return { ...DEFAULT_ENTITLEMENTS };
  return normalizeEntitlements(row);
}

/**
 * The create-input for an org's default entitlements on the active product, or
 * `null` when the product restricts nothing (⇒ leave the org row-free = all on).
 * Pure (no DB), so it's unit-testable.
 */
export function defaultEntitlementsInput(
  profile: ProductProfile,
): EntitlementsRow | null {
  const mods = profile.defaultEnabledModules;
  const secs = profile.defaultEnabledSectors;
  if (mods === null && secs === null) return null;
  return {
    moduleAllowlistEnabled: mods !== null,
    enabledModules: mods ?? [],
    sectorAllowlistEnabled: secs !== null,
    enabledSectors: secs ?? [],
  };
}

/**
 * Provision a new org's entitlements from the active product profile, with the
 * runtime `DEFAULT_ENABLED_MODULES`/`DEFAULT_ENABLED_SECTORS` env CSVs overriding
 * the profile defaults (Phase 3 one-image). Writes a row only when something is
 * restricted — an all-on resolution stays row-free (= all enabled), unchanged.
 */
export async function provisionEntitlements(orgId: string): Promise<void> {
  const input = resolveDefaultEntitlements(
    {
      modulesEnv: process.env.DEFAULT_ENABLED_MODULES,
      sectorsEnv: process.env.DEFAULT_ENABLED_SECTORS,
    },
    getBrand(),
  );
  if (!input) return;
  await prisma.orgEntitlements.create({ data: { orgId, ...input } });
}

/**
 * Filter a list of sector-tagged rows to the tenant's enabled sectors. Pure.
 * `enabledSectors === null` ⇒ all sectors (no-op). A `null` row sector is
 * sector-agnostic and always kept (board templates may have a null sector).
 */
export function filterBySector<T extends { sector: string | null }>(
  items: T[],
  ent: Entitlements,
): T[] {
  if (ent.enabledSectors === null) return items;
  const enabled = ent.enabledSectors;
  return items.filter((t) => t.sector === null || enabled.has(t.sector));
}

/**
 * Batch-load the per-org enabled-module allowlist for the nav. Returns a map of
 * orgId → `string[] | null` (null = all modules enabled). A missing row ⇒ null.
 * Serializable (plain arrays), so it crosses the RSC→client boundary in `orgs[]`.
 */
export async function getEnabledModulesByOrg(
  orgIds: string[],
): Promise<Map<string, string[] | null>> {
  const map = new Map<string, string[] | null>(orgIds.map((id) => [id, null]));
  if (orgIds.length === 0) return map;
  const rows = await prisma.orgEntitlements.findMany({
    where: { orgId: { in: orgIds } },
  });
  for (const row of rows) {
    map.set(row.orgId, row.moduleAllowlistEnabled ? row.enabledModules : null);
  }
  return map;
}
