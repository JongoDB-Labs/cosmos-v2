import type { MetadataRoute } from "next";
import { getBrand } from "@/lib/brand";

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
