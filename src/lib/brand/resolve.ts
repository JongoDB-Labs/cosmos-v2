import { getBrand } from "./index";
import type { ProductProfile } from "@/lib/product/profiles";

/**
 * The subset of Organization columns that override the build-time brand. All
 * optional + nullable; a null/absent field inherits the deployment default.
 * Declared structurally (not via `Pick<Organization,…>`) so this module never
 * imports the Prisma client and stays usable in pure unit tests.
 */
export type OrgBrandOverrides = {
  brandName?: string | null;
  logoUrl?: string | null;
  agentName?: string | null;
  tagline?: string | null;
  wakeWord?: string | null;
  defaultSkinId?: string | null;
};

/**
 * Overlay an org's non-null brand columns onto the active product profile.
 * Pure. `getBrand()` remains the source of the deployment/product default;
 * `resolveBrand` is the entry point for anything that should reflect an org.
 */
export function resolveBrand(org?: OrgBrandOverrides | null): ProductProfile {
  const base = getBrand();
  if (!org) return base;
  return {
    ...base,
    name: org.brandName ?? base.name,
    title: org.brandName ?? base.title,
    tagline: org.tagline ?? base.tagline,
    markSrc: org.logoUrl ?? base.markSrc,
    agentName: org.agentName ?? base.agentName,
    wakeWord: org.wakeWord ?? base.wakeWord,
    defaultSkinId: org.defaultSkinId ?? base.defaultSkinId,
  };
}

/**
 * Narrow a wider org row to ONLY the six branding fields. Used to build the
 * public brand payload and the BrandProvider seed without leaking other org
 * columns. Returns null for a null/undefined row.
 */
export function pickOrgBrand(
  org:
    | (OrgBrandOverrides & Record<string, unknown>)
    | null
    | undefined,
): OrgBrandOverrides | null {
  if (!org) return null;
  return {
    brandName: org.brandName ?? null,
    logoUrl: org.logoUrl ?? null,
    agentName: org.agentName ?? null,
    tagline: org.tagline ?? null,
    wakeWord: org.wakeWord ?? null,
    defaultSkinId: org.defaultSkinId ?? null,
  };
}
