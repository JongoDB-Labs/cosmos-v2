import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { PageShell } from "@/components/ui/page-shell";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { ClaudeSubscriptionPanel } from "@/components/settings/claude-subscription-panel";
import { EmptyState } from "@/components/ui/empty-state";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * AI / Model settings — the GUI surface for connecting this org's Claude (Pro/Max)
 * subscription that powers the AI agent.
 *
 * Cache Components: `await params` + the cookie read (getAuthContext) live INSIDE the
 * <Suspense> boundary (<Gate>), so the static shell ships immediately and the dynamic auth
 * read is suspended. THIN: the API is the source of truth; the panel just GET/POSTs the
 * claude-subscription routes.
 */
export default function AiSettingsPage({ params }: PageParams) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Gate params={params} />
    </Suspense>
  );
}

async function Gate({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // Tenant-admin gate (the panel mirrors the route's INTEGRATION_MANAGE check).
  if (!hasPermission(ctx.permissions, Permission.INTEGRATION_MANAGE)) {
    return (
      <PageShell title="AI / Model" description="Connect a Claude subscription">
        <EmptyState
          title="You don't have access"
          description="Connecting a Claude subscription requires the Integration Manage permission."
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="AI / Model"
      description="Connect a Claude (Pro/Max) subscription to power this org's AI agent"
    >
      <ClaudeSubscriptionPanel orgId={ctx.orgId} />
    </PageShell>
  );
}
