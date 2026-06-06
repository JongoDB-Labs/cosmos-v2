import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.npm_package_version ?? "0.0.0",
  },
  cacheComponents: true,
  experimental: {
    viewTransition: true,
  },
  images: {
    remotePatterns: [
      // Google profile avatars from OAuth.
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      { protocol: "https", hostname: "*.googleusercontent.com" },
      // Org-uploaded logos stored locally are absolute /uploads paths
      // (no remote pattern needed for those).
    ],
  },
  // pdfkit ships .afm font files it loads at runtime via fs; Turbopack
  // can't rewrite those paths, so leave it externalized.
  // googleapis is a large CJS surface that doesn't bundle cleanly; externalize.
  serverExternalPackages: ["pdfkit", "googleapis"],
};

export default withBundleAnalyzer(nextConfig);
