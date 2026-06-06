import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { ContractsList } from "@/components/contracts/contracts-list";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function ContractsPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell title="Contracts" description="Agreements, value, and signatures" maxWidth="7xl">
      <ContractsList orgId={ctx.orgId} />
    </PageShell>
  );
}
