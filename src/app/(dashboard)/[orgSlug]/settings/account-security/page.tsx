import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/session";
import { PageShell } from "@/components/ui/page-shell";
import { AccountSecurityPanel } from "@/components/security/account-security-panel";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function AccountSecurityPage({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  return (
    <PageShell
      title="Account security"
      description="Your password, two-factor authentication, and active sessions"
    >
      <AccountSecurityPanel />
    </PageShell>
  );
}
