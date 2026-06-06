import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { SecuritySettingsPanel } from "@/components/security/security-settings-panel";
import { PageShell } from "@/components/ui/page-shell";
import {
  makeServerQueryClient,
  dehydrate,
  HydrationBoundary,
} from "@/lib/query/server";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function SecurityPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // Prefetch the four queries the panel issues client-side so the dashboard
  // renders with data already in the React Query cache. Keys MUST match
  // useOrgQueryKey(...) in security-settings-panel.tsx exactly.
  const qc = makeServerQueryClient();
  await Promise.all([
    qc.prefetchQuery({
      queryKey: ["org", orgSlug, "security-settings"],
      queryFn: () =>
        prisma.orgSecuritySettings.findUnique({ where: { orgId: ctx.orgId } }),
    }),
    // NOTE: sessions are intentionally NOT prefetched. The client GET records
    // the caller's current session on view (sessions are created globally at
    // login with no org context); a server prefetch would hydrate an empty
    // list that staleTime keeps fresh, so the table would never populate.
    qc.prefetchQuery({
      queryKey: ["org", orgSlug, "security", "ip-allowlist"],
      queryFn: () =>
        prisma.ipAllowlist.findMany({
          where: { orgId: ctx.orgId },
          orderBy: { createdAt: "desc" },
        }),
    }),
    qc.prefetchQuery({
      queryKey: ["org", orgSlug, "security", "scim-tokens"],
      queryFn: () =>
        prisma.scimToken.findMany({
          where: { orgId: ctx.orgId },
          orderBy: { createdAt: "desc" },
        }),
    }),
  ]);

  return (
    <PageShell
      title="Security"
      description="SSO, sessions, and IP allowlists"
    >
      <HydrationBoundary state={dehydrate(qc)}>
        <SecuritySettingsPanel orgId={ctx.orgId} />
      </HydrationBoundary>
    </PageShell>
  );
}
