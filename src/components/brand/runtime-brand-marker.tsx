import { Suspense } from "react";
import { connection } from "next/server";

async function Connection() {
  await connection();
  return null;
}

/**
 * Tells Next.js that THIS PAGE deliberately renders at request time, so the
 * root layout's runtime-brand `generateMetadata()` (which awaits
 * `connection()` to read the live PRODUCT env) is expected rather than a
 * mistake. Renders nothing.
 *
 * Why the root layout's own marker is not enough: RootBrandProvider's
 * `connection()` satisfies the static-shell check for a document load, but
 * Next 16.4's dev instant-navigation validation treats every layout above the
 * page — the root one included — as already mounted on a client navigation, so
 * a hole there does not count. A page whose own subtree is otherwise fully
 * static then logs
 *   Route "/login": Next.js encountered uncached data in `generateMetadata()`
 * on every load. The docs' fix is a marker ON THE PAGE
 * (generate-metadata.md, "With Cache Components"); a marker in a segment
 * layout or a root template.tsx was tried and does not satisfy it.
 *
 * Dashboard pages do not need this: they read cookies inside their own
 * <Suspense>, which already marks them dynamic. Fully client pages (login,
 * reset-password) do — see runtime-brand-marker.arch.test.ts.
 */
export function RuntimeBrandMarker() {
  return (
    <Suspense fallback={null}>
      <Connection />
    </Suspense>
  );
}
