import { connection } from "next/server";
import { getBrand } from "@/lib/brand";
import { BrandProvider } from "@/components/providers/brand-provider";

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
