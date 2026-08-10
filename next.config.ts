import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";
import { legacyRedirectRules } from "./src/lib/nav/legacy-redirects";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  // Self-contained server bundle (.next/standalone/server.js) for a minimal,
  // non-root container image. See Dockerfile.
  output: "standalone",
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.npm_package_version ?? "0.0.0",
    // Selects the product brand at build time (cosmos, or a brand a plugin registers). Mirrors the
    // APP_VERSION pattern: the Dockerfile passes a PRODUCT build-arg → ENV PRODUCT,
    // and this inlines it as NEXT_PUBLIC_PRODUCT for getBrand() (client + server).
    NEXT_PUBLIC_PRODUCT: process.env.PRODUCT ?? "cosmos",
  },
  cacheComponents: true,
  // `experimental.viewTransition` was REMOVED in Next 16.3.0 — not renamed, and
  // not promoted to a top-level option. It is absent from ExperimentalConfig, its
  // config doc page is deleted, and the surviving view-transitions guide
  // documents no flag at all: React's <ViewTransition> works without one now.
  // Leaving the key set fails the typecheck with
  //   TS2353: 'viewTransition' does not exist in type 'ExperimentalConfig'
  // which is exactly what blocked this dependency bump.
  // The Accounting section moved from /{org}/finance/* to /{org}/accounting/*
  // so the URLs match the sidebar labels and breadcrumbs. Keep the old paths
  // alive for bookmarks/links — the map lives (and is unit-tested) in
  // src/lib/nav/legacy-redirects.ts.
  redirects: legacyRedirectRules,
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
  // Prisma 7's driver adapter (@prisma/adapter-pg, used by src/lib/db/client.ts) is
  // referenced as an external module in the server bundle, but Turbopack's standalone
  // tracer does NOT reliably copy it — or its @prisma/* runtime deps — into
  // .next/standalone/node_modules (unlike @prisma/client, which Next externalizes by
  // default and traces). Force the adapter closure into the trace so the standalone
  // runtime image can require it. pg + its deps are already traced via normal usage.
  outputFileTracingIncludes: {
    "**/*": [
      "./node_modules/@prisma/adapter-pg/**",
      "./node_modules/@prisma/driver-adapter-utils/**",
      "./node_modules/@prisma/debug/**",
    ],
  },
};

export default withBundleAnalyzer(nextConfig);
