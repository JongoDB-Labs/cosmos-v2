import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/session";
import { PageShell } from "@/components/ui/page-shell";
import { canViewPage } from "@/lib/nav/page-access";
import { NoPageAccess } from "@/components/ui/no-page-access";
import { TrialBalanceImport } from "@/components/accounting/trial-balance-import";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function AccountingImportPage({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // DERIVED from the nav declaration, never re-declared here — see
  // lib/nav/page-access.ts for why writing it twice is how the two drift.
  const allowed = canViewPage(ctx.permissions, "/accounting/import");

  return (
    <PageShell
      title="Import"
      description="Bring a trial balance from your bookkeeping system into the ledger"
      maxWidth="5xl"
    >
      {allowed ? <TrialBalanceImport orgId={ctx.orgId} /> : <NoPageAccess what="accounting import" />}
    </PageShell>
  );
}
