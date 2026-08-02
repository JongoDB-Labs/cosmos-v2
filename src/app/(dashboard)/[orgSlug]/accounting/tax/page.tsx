import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { TaxDashboard } from "@/components/tax/tax-dashboard";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function TaxPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell
      title="Tax"
      description="Sales-tax rates and the tax liability collected on invoices"
      maxWidth="7xl"
    >
      <TaxDashboard orgId={ctx.orgId} />
    </PageShell>
  );
}
