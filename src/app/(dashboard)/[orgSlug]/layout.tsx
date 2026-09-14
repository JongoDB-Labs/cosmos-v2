import { Suspense } from "react";
import { prisma } from "@/lib/db/client";
import { orgThemeCss } from "@/lib/theme/server-styles";
import { WhatsNew } from "@/components/whats-new/whats-new-modal";
import { TourMount } from "@/components/tour/tour-mount";
import { getAuthContext } from "@/lib/auth/session";

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
          and sits inside the DrawerProvider/TourProvider mounted by the shell. */}
      <Suspense fallback={null}>
        <TourIsland params={params} />
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

/**
 * Resolves the org for the walkthrough card. Separate island so the layout
 * itself stays synchronous and the card can be a client component that needs an
 * org id rather than a slug.
 */
async function TourIsland({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) return null;
  return <TourMount orgId={ctx.orgId} />;
}
