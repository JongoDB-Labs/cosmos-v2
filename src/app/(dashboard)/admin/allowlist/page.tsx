import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { AllowlistManager } from "./allowlist-manager";
import { PageShell } from "@/components/ui/page-shell";
import { requireSystemAdmin } from "@/lib/internal/require-system-admin";
import {
  makeServerQueryClient,
  dehydrate,
  HydrationBoundary,
} from "@/lib/query/server";

// cacheComponents enabled: `dynamic` segment config not supported (routes are dynamic by default).

export default async function AllowlistAdminPage() {
  // The allowlist is the instance-wide sign-in gate → SYSTEM admin only
  // (INTERNAL_ADMINS), not "owner of any org".
  const me = await requireSystemAdmin();
  if (!me) redirect("/");

  // Prefetch the same query the client will issue so the first paint shows
  // real data instead of a loading state.
  const qc = makeServerQueryClient();
  await qc.prefetchQuery({
    queryKey: ["admin", "allowed-emails"],
    queryFn: async () => {
      const entries = await prisma.allowedEmail.findMany({
        orderBy: { createdAt: "desc" },
      });
      return entries.map((e) => ({
        id: e.id,
        email: e.email,
        addedBy: e.addedBy,
        createdAt: e.createdAt.toISOString(),
      }));
    },
  });

  return (
    <PageShell
      title="Sign-in allowlist"
      description="Only the emails below can sign in with Google."
      maxWidth="5xl"
    >
      <HydrationBoundary state={dehydrate(qc)}>
        <AllowlistManager />
      </HydrationBoundary>
    </PageShell>
  );
}
