import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { PayrollDashboard } from "@/components/payroll/payroll-dashboard";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function PayrollPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell
      title="Payroll"
      description="Employee cost rates, pay runs, and labor cost distributed to the ledger by project"
      maxWidth="7xl"
    >
      <PayrollDashboard orgId={ctx.orgId} />
    </PageShell>
  );
}
