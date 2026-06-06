import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { AccountingDashboard } from "@/components/accounting/accounting-dashboard";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function AccountingPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell title="Accounting" description="Chart of accounts, journal entries, and financial statements" maxWidth="7xl">
      <AccountingDashboard orgId={ctx.orgId} />
    </PageShell>
  );
}
