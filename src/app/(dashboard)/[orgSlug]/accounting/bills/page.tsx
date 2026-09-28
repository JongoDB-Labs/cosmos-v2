import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { canViewPage } from "@/lib/nav/page-access";
import { NoPageAccess } from "@/components/ui/no-page-access";
import { PageShell } from "@/components/ui/page-shell";
import { BillsWorkspace } from "@/components/payables/bills-workspace";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function BillsPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // The sidebar hides this from anyone without the permission; enforcing it
  // HERE is what stops the URL being typed in directly.
  const allowed = canViewPage(ctx.permissions, "/accounting/bills");

  return (
    <PageShell
      title="Bills"
      description="What consultants and suppliers have invoiced the practice, and what is still owed"
      maxWidth="7xl"
    >
      {allowed ? <BillsWorkspace orgId={ctx.orgId} /> : <NoPageAccess what="bills" />}
    </PageShell>
  );
}
