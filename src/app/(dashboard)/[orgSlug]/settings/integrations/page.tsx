import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { IntegrationsManager } from "@/components/settings/integrations-manager";
import { PageShell } from "@/components/ui/page-shell";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { NoAccess } from "@/components/settings/no-access";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function IntegrationsPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  if (!canViewSettings(ctx, "/settings/integrations")) {
    return (
      <PageShell title="Integrations" description="Connect external tools">
        <NoAccess what="integrations" />
      </PageShell>
    );
  }

  return (
    <PageShell title="Integrations" description="Connect external tools">
      <IntegrationsManager orgId={ctx.orgId} />
    </PageShell>
  );
}
