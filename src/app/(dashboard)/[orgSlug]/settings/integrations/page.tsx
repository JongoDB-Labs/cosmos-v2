import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { IntegrationsManager } from "@/components/settings/integrations-manager";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function IntegrationsPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell title="Integrations" description="Connect external tools">
      <IntegrationsManager orgId={ctx.orgId} />
    </PageShell>
  );
}
