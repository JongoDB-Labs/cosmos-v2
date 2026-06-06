import { BRAND_ICONS } from "./brand-icons.generated";

export interface BrandIconData {
  path: string;
  hex: string;
}

// Hand-vendored marks for brands simple-icons does not carry. Extension point:
// add ONLY genuine 24x24 single-path SVG data here — never fabricate paths.
export const VENDORED_ICONS: Record<string, BrandIconData> = {};

export function resolveBrandIcon(icon: string): BrandIconData | null {
  return BRAND_ICONS[icon] ?? VENDORED_ICONS[icon] ?? null;
}
