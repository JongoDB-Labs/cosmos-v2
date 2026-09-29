import type { MetadataRoute } from "next";
import { getBrand } from "@/lib/brand";

// Registers a composed plugin's product profile before getBrand() reads it.
// Without this the brand depends on whether some OTHER route happened to pull
// the seam in first -- see root-brand-provider.tsx for the whole story, and
// src/lib/brand/__tests__/brand-registration.arch.test.ts for the rule.
import "@/lib/plugins/registry/server";

export default function manifest(): MetadataRoute.Manifest {
  const brand = getBrand();
  return {
    name: brand.name,
    short_name: brand.name,
    description: brand.description,
    start_url: "/",
    display: "standalone",
    background_color: brand.backgroundColor,
    theme_color: brand.themeColor,
    orientation: "any",
    icons: [
      { src: brand.markSrc, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: brand.markSrc, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
