import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { redirect } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { NoAccess } from "@/components/settings/no-access";
import { OrgGeneralSettings } from "@/components/settings/org-general-settings";
import {
  OrgBrandingSection,
  type OrgBrandingInitial,
} from "@/components/settings/org-branding-section";
import { Separator } from "@/components/ui/separator";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function OrganizationPage({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  if (!canViewSettings(ctx, "/settings/organization")) {
    return (
      <PageShell title="Organization" description="Identity & branding">
        <NoAccess what="organization settings" />
      </PageShell>
    );
  }

  const canUpdate = hasPermission(ctx.permissions, Permission.ORG_UPDATE);
  const canBrand = hasPermission(ctx.permissions, Permission.THEME_MANAGE);

  const org = await prisma.organization.findUnique({
    where: { id: ctx.orgId },
    select: {
      name: true,
      slug: true,
      logoUrl: true,
      plan: true,
      tenantClass: true,
      themePrimary: true,
      themeMode: true,
      defaultSkinId: true,
      brandName: true,
      agentName: true,
      tagline: true,
      wakeWord: true,
    },
  });
  if (!org) redirect("/");

  const branding: OrgBrandingInitial = {
    themePrimary: org.themePrimary,
    themeMode: org.themeMode,
    logoUrl: org.logoUrl,
    defaultSkinId: org.defaultSkinId,
    brandName: org.brandName,
    agentName: org.agentName,
    tagline: org.tagline,
    wakeWord: org.wakeWord,
  };

  return (
    <PageShell
      title="Organization"
      description="Your organization's identity and branding"
    >
      <div className="flex flex-col gap-8">
        {/* Identity always renders for anyone who can view this page. A THEME_MANAGE-only
            admin (no ORG_UPDATE) sees it read-only (canUpdate=false → disabled inputs +
            org metadata) for context while they edit branding below. */}
        <section>
          <h3 className="mb-3 text-sm font-semibold">Identity</h3>
          <OrgGeneralSettings
            orgId={ctx.orgId}
            canUpdate={canUpdate}
            initial={{
              name: org.name,
              slug: org.slug,
              logoUrl: org.logoUrl,
              plan: org.plan,
              tenantClass: org.tenantClass,
            }}
          />
        </section>
        {canBrand && (
          <>
            <Separator />
            <section>
              <h3 className="mb-1 text-sm font-semibold">
                Brand &amp; member defaults
              </h3>
              <p className="mb-3 text-xs text-muted-foreground">
                Primary color, white-label identity, and the skin &amp; mode
                new members get before they choose their own.
              </p>
              <OrgBrandingSection orgId={ctx.orgId} initial={branding} />
            </section>
          </>
        )}
      </div>
    </PageShell>
  );
}
