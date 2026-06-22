import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { redirect } from "next/navigation";
import { PreferencesForm } from "@/components/settings/preferences-form";
import { PageShell } from "@/components/ui/page-shell";
import type { OrgBrandingInitial } from "@/components/settings/org-branding-section";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function PreferencesPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const canManageBranding = hasPermission(ctx.permissions, Permission.THEME_MANAGE);

  let orgBranding: OrgBrandingInitial | null = null;
  if (canManageBranding) {
    const org = await prisma.organization.findUnique({
      where: { id: ctx.orgId },
      select: {
        themePrimary: true,
        themeMode: true,
        logoUrl: true,
        defaultSkinId: true,
        brandName: true,
        agentName: true,
        tagline: true,
        wakeWord: true,
      },
    });
    if (org) {
      orgBranding = org;
    }
  }

  return (
    <PageShell title="Preferences" description="General workspace settings">
      <PreferencesForm
        orgId={ctx.orgId}
        canManageBranding={canManageBranding}
        orgBranding={orgBranding}
      />
    </PageShell>
  );
}
