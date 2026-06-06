import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { getCurrentUser } from "@/lib/auth/session";
import { AllowlistManager } from "./allowlist-manager";
import { PageShell } from "@/components/ui/page-shell";
import {
  makeServerQueryClient,
  dehydrate,
  HydrationBoundary,
} from "@/lib/query/server";

// cacheComponents enabled: `dynamic` segment config not supported (routes are dynamic by default).

export default async function AllowlistAdminPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect("/login");

  // OWNER of any org gets in. We deliberately do not tie this to an org slug
  // because the allowlist is a global gate.
  const ownerMembership = await prisma.orgMember.findFirst({
    where: { userId: currentUser.id, role: "OWNER" },
    select: { id: true },
  });
  if (!ownerMembership) redirect("/");

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
