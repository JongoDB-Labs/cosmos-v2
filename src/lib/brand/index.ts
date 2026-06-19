import {
  PRODUCT_PROFILES,
  type ProductKey,
  type ProductProfile,
} from "@/lib/product/profiles";

/**
 * Resolve the active product key for this render.
 *
 * Phase 3 (one image): the per-deployment product is a RUNTIME env. Precedence:
 *   1. `process.env.PRODUCT`            — server runtime (set per container; the
 *                                          one-image deployment default).
 *   2. `process.env.NEXT_PUBLIC_PRODUCT`— client-baked fallback; the build bakes
 *                                          a NEUTRAL "cosmos" default so an
 *                                          un-parameterized build is unchanged.
 *   3. "cosmos"                          — final default.
 * The resolved value is validated against PRODUCT_PROFILES keys; an unknown
 * value (typo, stale env) falls back to "cosmos" rather than crashing getBrand().
 */
function resolveProductKey(): ProductKey {
  const raw = process.env.PRODUCT ?? process.env.NEXT_PUBLIC_PRODUCT ?? "cosmos";
  // Object.hasOwn (not bare `raw in PRODUCT_PROFILES`) so an inherited
  // Object.prototype key (e.g. PRODUCT="constructor"/"toString") can't pass
  // validation and return a non-profile object.
  return Object.hasOwn(PRODUCT_PROFILES, raw) ? (raw as ProductKey) : "cosmos";
}

/**
 * The active product profile. `NEXT_PUBLIC_PRODUCT` is inlined at build time
 * from the `PRODUCT` build-arg (see next.config.ts + Dockerfile), so in a real
 * build this is a constant; under test it reads the env dynamically.
 * Phase 3: `process.env.PRODUCT` (server runtime) takes precedence.
 */
export function getBrand(): ProductProfile {
  return PRODUCT_PROFILES[resolveProductKey()];
}

export { resolveBrand, pickOrgBrand, type OrgBrandOverrides } from "./resolve";
