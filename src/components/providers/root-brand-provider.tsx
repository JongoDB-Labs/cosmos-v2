import { connection } from "next/server";
import { getBrand } from "@/lib/brand";
import { BrandProvider } from "@/components/providers/brand-provider";

// Load the plugin composition seam BEFORE anything here resolves the brand.
//
// getBrand() validates PRODUCT against PRODUCT_PROFILES and falls back to the
// neutral brand for a key the registry does not have. A composed plugin writes
// its own profile into that registry as a side effect of this import, and
// PRODUCT_PROFILES is a module-level singleton -- so the profile is only there
// once something in the process has actually imported the seam.
//
// Nothing guaranteed that had happened by the time a request arrived, and the
// SIGN-IN PAGE is the case that lost: it is the first thing anyone hits after a
// restart, so it rendered under the NEUTRAL product's name, title, tagline and
// mark, then healed silently the moment any other route pulled the seam in.
// Observed on the same process one minute apart: COSMOS cold, the deployment's
// real product after one dashboard render. instrumentation.ts also loads this
// at boot, but boot is not ordered against the first request.
//
// The PUBLIC core composes no plugins, so this is an empty no-op there.
import "@/lib/plugins/registry/server";

/**
 * Seed the client BrandProvider with the DEPLOYMENT-DEFAULT brand resolved at
 * REQUEST TIME (not prerender). Under Cache Components a synchronous
 * `process.env.PRODUCT` read in a server component is statically inlined with
 * the build-time value; `await connection()` halts prerendering so getBrand()
 * reads the live container env (the one-image PRODUCT=<key>). Rendered inside a
 * <Suspense> by the root layout, so the static shell still prerenders and this
 * streams in (connection() only defers — no I/O, sub-ms).
 *
 * The dashboard layout RE-seeds BrandProvider per-org (Phase 2); this root seed
 * governs the pre-login chrome (login page, collapsed sidebar label) only.
 */
export async function RootBrandProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  await connection();
  return <BrandProvider value={getBrand()}>{children}</BrandProvider>;
}
