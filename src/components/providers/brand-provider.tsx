"use client";

import { createContext, useContext } from "react";
import { getBrand } from "@/lib/brand";
import type { ProductProfile } from "@/lib/product/profiles";

/**
 * Client brand context. Seeded by the dashboard SERVER layout with
 * resolveBrand(org) so deep chrome (sidebar, agent bubble, wake-word) shows the
 * org-correct name/agent/wake-word without threading a prop through every
 * component. With no provider (pre-login chrome, isolated renders) useBrand()
 * falls back to the build-time getBrand() so nothing breaks.
 */
const BrandContext = createContext<ProductProfile | null>(null);

export function BrandProvider({
  value,
  children,
}: {
  value: ProductProfile;
  children: React.ReactNode;
}) {
  return <BrandContext.Provider value={value}>{children}</BrandContext.Provider>;
}

export function useBrand(): ProductProfile {
  return useContext(BrandContext) ?? getBrand();
}
