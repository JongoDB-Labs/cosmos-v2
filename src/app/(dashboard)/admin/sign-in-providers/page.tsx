import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { PageShell } from "@/components/ui/page-shell";
import { SignInProvidersManager } from "./sign-in-providers-manager";

// cacheComponents enabled: `dynamic` segment config not supported (routes are
// dynamic by default). Mirrors the allowlist admin page.
export default async function SignInProvidersAdminPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect("/login");

  // OWNER of any org — same global-admin proxy as the allowlist page. Sign-in
  // providers are an instance-wide setting, not tied to one org slug.
  const ownerMembership = await prisma.orgMember.findFirst({
    where: { userId: currentUser.id, role: "OWNER" },
    select: { id: true },
  });
  if (!ownerMembership) redirect("/");

  return (
    <PageShell
      title="Sign-in providers"
      description="OAuth apps for Microsoft / Google login. Credentials are stored encrypted (vault-sealed) and managed here — never in env files."
    >
      <SignInProvidersManager />
    </PageShell>
  );
}
