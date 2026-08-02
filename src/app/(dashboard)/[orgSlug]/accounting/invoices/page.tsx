import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { InvoicesDashboard } from "@/components/invoicing/invoices-dashboard";
import { PageShell } from "@/components/ui/page-shell";
import { canViewPage } from "@/lib/nav/page-access";
import { NoPageAccess } from "@/components/ui/no-page-access";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function InvoicesPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // The sidebar hides this section from anyone without the permission;
  // enforcing it HERE is what stops the URL being typed in directly.
  const allowed = canViewPage(ctx.permissions, "/accounting/invoices");

  return (
    <PageShell
      title="Invoices"
      description="Create and send invoices, record payments, and track AR aging"
      maxWidth="7xl"
    >
      {allowed ? (
        <InvoicesDashboard orgId={ctx.orgId} />
      ) : (
        <NoPageAccess what="invoices" />
      )}
    </PageShell>
  );
}
