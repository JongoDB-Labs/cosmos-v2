import type { ModuleKey, SectorKey } from "@/lib/entitlements/modules";

/**
 * A product brand key. The public core ships exactly one brand ("cosmos");
 * additional brands are contributed at build time by composed plugins via
 * {@link registerProductProfile}, so this is an open `string` rather than a
 * closed union — an unknown key falls back to "cosmos" in getBrand().
 */
export type ProductKey = string;

export type ProductProfile = {
  key: ProductKey;
  /** User-facing product name, e.g. "COSMOS". */
  name: string;
  /** Browser tab / <title> + metadata title. */
  title: string;
  /** One-line description (metadata + manifest). */
  description: string;
  /** Short tagline shown under the mark on the login screen. */
  tagline: string;
  /** Path under /public to the square brand mark PNG. */
  markSrc: string;
  /** PWA + browser theme color (top-of-viewport chrome). */
  themeColor: string;
  /** PWA manifest background color. */
  backgroundColor: string;
  /** Name of the in-app AI assistant, e.g. "COSMOS Agent". */
  agentName: string;
  /** Spoken wake phrase, lowercase, matched by the recognizer. */
  wakePhrase: string;
  /** Display form of the wake phrase, e.g. "Hey Cosmo". */
  wakeWord: string;
  /** Default TenantClass for orgs created on this product. */
  defaultTenantClass: "GOV" | "COMMERCIAL";
  /** Container signing mode used by the release pipeline. */
  signingMode: "kms" | "keyless";
  /** Default module allowlist for a new org on this product. `null` = all modules. */
  defaultEnabledModules: ModuleKey[] | null;
  /** Default sector allowlist for a new org. `null` = all sectors. */
  defaultEnabledSectors: SectorKey[] | null;
  /** Registry ID of the skin applied by default for this product. */
  defaultSkinId: string;
  /** Plugins auto-enabled for a new org on this product (fail-closed axis: absent =
   *  none). Slugs must exist in the plugin registry (src/lib/plugins/registry.ts);
   *  slugs whose plugin isn't composed into this build are ignored at provision time. */
  defaultEnabledPlugins: string[];
};

/**
 * The neutral, client-agnostic default brand. This is the ONLY profile the
 * public core ships. Vertical/client brands live in their own private plugin
 * and register themselves at build time through {@link registerProductProfile}.
 */
const COSMOS_PROFILE: ProductProfile = {
  key: "cosmos",
  name: "COSMOS",
  title: "COSMOS — Enterprise Project Management",
  description:
    "Multi-tenant project management platform with boards, OKRs, CRM, and more.",
  tagline: "Enterprise Project Management",
  markSrc: "/cosmos-mark.png",
  themeColor: "#0B0E1A",
  backgroundColor: "#0B0E1A",
  agentName: "COSMOS Agent",
  // "hey cosmo" is a substring of the old "hey cosmos", so legacy utterances
  // still wake it — muscle memory keeps working.
  wakePhrase: "hey cosmo",
  wakeWord: "Hey Cosmo",
  defaultTenantClass: "GOV",
  signingMode: "kms",
  defaultEnabledModules: null,
  defaultEnabledSectors: null,
  defaultSkinId: "universe",
  defaultEnabledPlugins: [],
};

/**
 * Live registry of product profiles, keyed by ProductKey. Seeded with the
 * neutral "cosmos" brand; a composed plugin adds its own brand at module-load
 * via {@link registerProductProfile}. getBrand() resolves against this map and
 * falls back to "cosmos" for any unknown/unregistered key.
 */
export const PRODUCT_PROFILES: Record<ProductKey, ProductProfile> = {
  cosmos: COSMOS_PROFILE,
};

/**
 * Register (or override) a product brand profile. Called at module-load by a
 * composed brand plugin's server registration so a `PRODUCT=<key>` build resolves
 * to that brand. No-op in the neutral public core (nothing calls it). Idempotent.
 */
export function registerProductProfile(profile: ProductProfile): void {
  PRODUCT_PROFILES[profile.key] = profile;
}
