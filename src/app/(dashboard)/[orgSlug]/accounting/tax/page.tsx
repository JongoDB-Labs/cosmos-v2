import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { TaxDashboard } from "@/components/tax/tax-dashboard";
import { PageShell } from "@/components/ui/page-shell";
import { canViewPage } from "@/lib/nav/page-access";
import { NoPageAccess } from "@/components/ui/no-page-access";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function TaxPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // The sidebar hides this section from anyone without the permission;
  // enforcing it HERE is what stops the URL being typed in directly.
  const allowed = canViewPage(ctx.permissions, "/accounting/tax");

  return (
    <PageShell
      title="Tax"
      description="Sales-tax rates and the tax liability collected on invoices"
      maxWidth="7xl"
    >
      {allowed ? (
        <TaxDashboard orgId={ctx.orgId} />
      ) : (
        <NoPageAccess what="tax" />
      )}
    </PageShell>
  );
}
