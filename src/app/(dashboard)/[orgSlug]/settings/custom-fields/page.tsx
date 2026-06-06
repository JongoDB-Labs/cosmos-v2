import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { CustomFieldsManager } from "@/components/settings/custom-fields-manager";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function CustomFieldsPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell
      title="Custom fields"
      description="Per-entity field schemas"
    >
      <CustomFieldsManager orgId={ctx.orgId} />
    </PageShell>
  );
}
