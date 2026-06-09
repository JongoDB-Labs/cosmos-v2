import { redirect } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";
import { SignInProvidersManager } from "./sign-in-providers-manager";

// cacheComponents enabled: `dynamic` segment config not supported (routes are
// dynamic by default).
export default async function SignInProvidersAdminPage() {
  // Instance-wide auth config → SYSTEM admin only (not "owner of any org").
  const me = await requireSystemAdmin();
  if (!me) redirect("/");

  return (
    <PageShell
      title="Sign-in providers"
      description="OAuth apps for Microsoft / Google login. Credentials are stored encrypted (vault-sealed) and managed here — never in env files."
    >
      <SignInProvidersManager />
    </PageShell>
  );
}
