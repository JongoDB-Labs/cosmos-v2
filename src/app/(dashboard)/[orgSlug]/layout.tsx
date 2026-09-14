import { Suspense } from "react";
import { prisma } from "@/lib/db/client";
import { orgThemeCss } from "@/lib/theme/server-styles";
import { WhatsNew } from "@/components/whats-new/whats-new-modal";
import { TourMount } from "@/components/tour/tour-mount";

type LayoutParams = { params: Promise<{ orgSlug: string }> };

/**
 * Per-org layout. Instant-shell validation requires `await params` to live
 * inside a <Suspense> boundary — so the theme `<style>` injection is
 * deferred into <OrgThemeStyle>, and `children` renders immediately.
 *
 * The fallback is `null` (not a placeholder) so we don't flash unstyled
 * content. The base globals.css always defines a default `--primary`; the
 * style override only adds the org-specific value when set.
 */
export default function OrgScopedLayout({
  children,
  params,
}: LayoutParams & { children: React.ReactNode }) {
  return (
    <>
      <Suspense fallback={null}>
        <OrgThemeStyle params={params} />
      </Suspense>
      {children}
      {/* "What's new" changelog — a fully-client island (reads the inlined app
          version + localStorage), so it's safe outside a Suspense boundary and
          renders nothing until it has an unseen release to show. */}
      <WhatsNew />
      {/* The guided walkthrough, when one is running. Renders nothing otherwise,
          and sits inside the DrawerProvider/TourProvider mounted by the shell.
          A pure client island: it reads the org from context rather than the
          server, because an awaited session read HERE is an uncached read in a
          layout above every org route, and Next rejects the prerender for all
          of them.

          Inside <Suspense> because it calls useSearchParams(). Next's own docs
          are unconditional on this — "The useSearchParams hook ALWAYS needs a
          <Suspense> boundary, since search params are only known at request
          time" — and the cost of omitting it is paid by everything around it:
          calling it opts "the Client Component tree up to the closest Suspense
          boundary" out of prerendering. From a layout above every org route,
          that tree is every org route. The boundary keeps the blast radius to
          this island, which renders nothing anyway until a tour is running. */}
      <Suspense fallback={null}>
        <TourMount />
      </Suspense>
    </>
  );
}

async function OrgThemeStyle({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const org = await getOrgThemePrimary(orgSlug);
  const css = orgThemeCss(org?.themePrimary);
  if (!css) return null;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

async function getOrgThemePrimary(slug: string) {
  "use cache";
  return prisma.organization.findUnique({
    where: { slug },
    select: { themePrimary: true },
  });
}
