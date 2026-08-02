import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { BankingInbox } from "@/components/banking/banking-inbox";
import { PageShell } from "@/components/ui/page-shell";
import { canViewPage } from "@/lib/nav/page-access";
import { NoPageAccess } from "@/components/ui/no-page-access";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function BankingPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // The sidebar hides this section from anyone without the permission;
  // enforcing it HERE is what stops the URL being typed in directly.
  const allowed = canViewPage(ctx.permissions, "/accounting/banking");

  return (
    <PageShell title="Banking" description="Review imported bank transactions, categorize, and post as expenses" maxWidth="7xl">
      {allowed ? (
        <BankingInbox orgId={ctx.orgId} />
      ) : (
        <NoPageAccess what="banking" />
      )}
    </PageShell>
  );
}
