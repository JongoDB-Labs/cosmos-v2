import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { PayrollDashboard } from "@/components/payroll/payroll-dashboard";
import { PageShell } from "@/components/ui/page-shell";
import { canViewPage } from "@/lib/nav/page-access";
import { NoPageAccess } from "@/components/ui/no-page-access";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function PayrollPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // The sidebar hides this section from anyone without the permission;
  // enforcing it HERE is what stops the URL being typed in directly.
  const allowed = canViewPage(ctx.permissions, "/accounting/payroll");

  return (
    <PageShell
      title="Payroll"
      description="Employee cost rates, pay runs, and labor cost distributed to the ledger by project"
      maxWidth="7xl"
    >
      {allowed ? (
        <PayrollDashboard orgId={ctx.orgId} />
      ) : (
        <NoPageAccess what="payroll" />
      )}
    </PageShell>
  );
}
