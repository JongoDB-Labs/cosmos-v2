import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { PageShell } from "@/components/ui/page-shell";
import { NavVisibility, type NavSection } from "@/components/settings/nav-visibility";
import { SIDEBAR_NAV } from "@/components/layouts/nav-config";
import { readNavLayout } from "@/lib/nav/nav-layout";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Which sections this organisation shows in its sidebar.
 *
 * Lists the CORE sections only. Plugin sections are governed by enabling or
 * disabling the plugin itself, which is a stronger statement than hiding its
 * menu entry and already has its own screen — offering both would leave an admin
 * wondering which one actually turned the thing off.
 */
export default async function NavigationSettingsPage({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  if (!canViewSettings(ctx, "/settings/navigation")) redirect(`/${orgSlug}/settings`);

  const org = await prisma.organization.findUnique({
    where: { id: ctx.orgId },
    select: { settings: true },
  });

  const sections: NavSection[] = SIDEBAR_NAV.map((e) => ({ id: e.id, label: e.label }));

  return (
    <PageShell
      title="Navigation"
      description="Which sections appear in this organisation's sidebar"
    >
      <NavVisibility
        orgId={ctx.orgId}
        sections={sections}
        initialHidden={readNavLayout(org?.settings)?.hidden ?? []}
      />
    </PageShell>
  );
}
