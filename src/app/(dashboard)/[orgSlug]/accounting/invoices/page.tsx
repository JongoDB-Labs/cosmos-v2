import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { InvoicesDashboard } from "@/components/invoicing/invoices-dashboard";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function InvoicesPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell
      title="Invoices"
      description="Create and send invoices, record payments, and track AR aging"
      maxWidth="7xl"
    >
      <InvoicesDashboard orgId={ctx.orgId} />
    </PageShell>
  );
}
