import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  // Self-contained server bundle (.next/standalone/server.js) for a minimal,
  // non-root container image. See Dockerfile.
  output: "standalone",
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.npm_package_version ?? "0.0.0",
    // Selects the product brand at build time (cosmos | pontis). Mirrors the
    // APP_VERSION pattern: the Dockerfile passes a PRODUCT build-arg → ENV PRODUCT,
    // and this inlines it as NEXT_PUBLIC_PRODUCT for getBrand() (client + server).
    NEXT_PUBLIC_PRODUCT: process.env.PRODUCT ?? "cosmos",
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
  // @huggingface/transformers loads the onnxruntime-node native binary + the
  // bundled MiniLM model cache from disk relative to its own package dir; it must
  // stay external so Next copies the real package (not a rewritten bundle) into
  // .next/standalone/node_modules. The Dockerfile additionally bakes in the
  // onnxruntime native deps + model cache for offline (gov) inference.
  serverExternalPackages: ["pdfkit", "googleapis", "@huggingface/transformers"],
};

export default withBundleAnalyzer(nextConfig);
