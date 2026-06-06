import { Suspense } from "react";
import { prisma } from "@/lib/db/client";
import { orgThemeCss } from "@/lib/theme/server-styles";

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
