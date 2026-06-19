import {
  PRODUCT_PROFILES,
  type ProductKey,
  type ProductProfile,
} from "@/lib/product/profiles";

function resolveProductKey(): ProductKey {
  return process.env.NEXT_PUBLIC_PRODUCT === "pontis" ? "pontis" : "cosmos";
}

/**
 * The active product profile. `NEXT_PUBLIC_PRODUCT` is inlined at build time
 * from the `PRODUCT` build-arg (see next.config.ts + Dockerfile), so in a real
 * build this is a constant; under test it reads the env dynamically.
 */
export function getBrand(): ProductProfile {
  return PRODUCT_PROFILES[resolveProductKey()];
}

export { resolveBrand, pickOrgBrand, type OrgBrandOverrides } from "./resolve";
