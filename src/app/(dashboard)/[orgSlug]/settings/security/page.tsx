import { getAuthContext } from "@/lib/auth/session";
import { securitySettingsFor } from "@/lib/auth/ip-allowlist";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { Permission, hasPermission } from "@/lib/rbac/permissions";
import { SecuritySettingsPanel } from "@/components/security/security-settings-panel";
import { PageShell } from "@/components/ui/page-shell";
import { NoAccess } from "@/components/settings/no-access";
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

  if (!canViewSettings(ctx, "/settings/security")) {
    return (
      <PageShell title="Security" description="Single sign-on, sessions, and IP allowlists">
        <NoAccess what="organization security policy" />
      </PageShell>
    );
  }

  // The page needs SECURITY_MANAGE; its sessions and SCIM sections each have a
  // bit of their own, the same ones their REST routes check.
  const canManageSessions = hasPermission(ctx.permissions, Permission.SESSION_MANAGE);
  const canManageScim = hasPermission(ctx.permissions, Permission.SCIM_MANAGE);

  // Prefetch the queries the panel issues client-side so the dashboard renders
  // with data already in the React Query cache. Keys MUST match
  // useOrgQueryKey(...) in security-settings-panel.tsx exactly.
  const qc = makeServerQueryClient();
  await Promise.all([
    // The same answer as GET /security/settings, address included: the panel
    // renders from this and doesn't refetch.
    qc.prefetchQuery({
      queryKey: ["org", orgSlug, "security-settings"],
      queryFn: async () => securitySettingsFor(ctx.orgId, await headers()),
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
    // Same gate and projection as GET /security/scim-tokens: never the hash.
    // A token's secret is shown once, in the response that creates it.
    ...(canManageScim
      ? [
          qc.prefetchQuery({
            queryKey: ["org", orgSlug, "security", "scim-tokens"],
            queryFn: () =>
              prisma.scimToken.findMany({
                where: { orgId: ctx.orgId },
                select: {
                  id: true,
                  prefix: true,
                  label: true,
                  expiresAt: true,
                  lastUsed: true,
                  createdAt: true,
                },
                orderBy: { createdAt: "desc" },
              }),
          }),
        ]
      : []),
  ]);

  return (
    <PageShell
      tourAnchor="security"
      title="Security"
      description="Single sign-on, sessions, and IP allowlists"
    >
      <HydrationBoundary state={dehydrate(qc)}>
        <SecuritySettingsPanel
          orgId={ctx.orgId}
          canManageSessions={canManageSessions}
          canManageScim={canManageScim}
        />
      </HydrationBoundary>
    </PageShell>
  );
}
