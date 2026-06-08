import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { BankingInbox } from "@/components/banking/banking-inbox";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function BankingPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell title="Banking" description="Review imported bank transactions, categorize, and post as expenses" maxWidth="7xl">
      <BankingInbox orgId={ctx.orgId} />
    </PageShell>
  );
}
