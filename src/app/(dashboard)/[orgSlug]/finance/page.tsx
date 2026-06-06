import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { FinanceDashboard } from "@/components/finance/finance-dashboard";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function FinancePage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell title="Finance" description="Revenue, expenses, and contracts" maxWidth="7xl">
      <FinanceDashboard orgId={ctx.orgId} userId={ctx.userId} />
    </PageShell>
  );
}
