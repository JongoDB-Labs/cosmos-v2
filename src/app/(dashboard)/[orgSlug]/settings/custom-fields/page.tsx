import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { CustomFieldsManager } from "@/components/settings/custom-fields-manager";
import { PageShell } from "@/components/ui/page-shell";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { NoAccess } from "@/components/settings/no-access";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function CustomFieldsPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  if (!canViewSettings(ctx, "/settings/custom-fields")) {
    return (
      <PageShell
        title="Custom fields"
        description="Per-entity field schemas"
      >
        <NoAccess what="custom fields" />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Custom fields"
      description="Per-entity field schemas"
    >
      <CustomFieldsManager orgId={ctx.orgId} />
    </PageShell>
  );
}
