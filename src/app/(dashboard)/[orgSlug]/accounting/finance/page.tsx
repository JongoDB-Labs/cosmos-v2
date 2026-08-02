import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { FinanceDashboard } from "@/components/finance/finance-dashboard";
import { PageShell } from "@/components/ui/page-shell";
import { canViewPage } from "@/lib/nav/page-access";
import { NoPageAccess } from "@/components/ui/no-page-access";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function FinancePage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // The sidebar hides this section from anyone without the permission;
  // enforcing it HERE is what stops the URL being typed in directly.
  const allowed = canViewPage(ctx.permissions, "/accounting/finance");

  return (
    <PageShell
      title="Finance"
      description="Revenue, expenses, and the accounting ledger"
      maxWidth="7xl"
    >
      {allowed ? (
        <FinanceDashboard orgId={ctx.orgId} userId={ctx.userId} />
      ) : (
        <NoPageAccess what="finance" />
      )}
    </PageShell>
  );
}
