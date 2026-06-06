import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { PipelineBoard } from "@/components/crm/pipeline-board";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function CrmPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell title="CRM" description="Pipeline and contacts" maxWidth="7xl">
      <PipelineBoard orgId={ctx.orgId} />
    </PageShell>
  );
}
