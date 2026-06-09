import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { SecuritySettingsPanel } from "@/components/security/security-settings-panel";
import { AccountSecurityPanel } from "@/components/security/account-security-panel";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
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

  // The org-policy panel (and its prefetch, which reads SCIM tokens + the
  // allowlist) is for SECURITY_MANAGE holders only — the backing routes already
  // enforce that, so a member without it would otherwise just see the panel
  // error out. The personal "Your account" panel stays visible to everyone.
  const canManageSecurity = hasPermission(
    ctx.permissions,
    Permission.SECURITY_MANAGE,
  );

  // Prefetch the queries the panel issues client-side so the dashboard renders
  // with data already in the React Query cache. Keys MUST match
  // useOrgQueryKey(...) in security-settings-panel.tsx exactly. Only when the
  // caller may manage security — otherwise we'd hydrate sensitive config for a
  // member who can't view it.
  const qc = makeServerQueryClient();
  if (canManageSecurity) {
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
  }

  return (
    <PageShell
      title="Security"
      description="Your account security, SSO, sessions, and IP allowlists"
    >
      <div className="space-y-8">
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Your account
          </h2>
          <AccountSecurityPanel />
        </div>
        <div>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">
            Organization policy
          </h2>
          {canManageSecurity ? (
            <HydrationBoundary state={dehydrate(qc)}>
              <SecuritySettingsPanel orgId={ctx.orgId} />
            </HydrationBoundary>
          ) : (
            <EmptyState
              title="You don't have access"
              description="Managing organization security policy requires the Manage Security permission. Your personal account security is above."
            />
          )}
        </div>
      </div>
    </PageShell>
  );
}
