import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/session";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { PageShell } from "@/components/ui/page-shell";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { AiProviderPanel } from "@/components/settings/ai-provider-panel";
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

  // Gate MUST match what the /ai/* routes actually enforce (ORG_MANAGE_SETTINGS)
  // — they all use it, so gating the page on INTEGRATION_MANAGE let the page
  // render for users whose every fetch/mutation then 403'd, and blocked users
  // the routes would have allowed.
  if (!hasPermission(ctx.permissions, Permission.ORG_MANAGE_SETTINGS)) {
    return (
      <PageShell title="AI / Model" description="Connect a Claude subscription">
        <EmptyState
          title="You don't have access"
          description="Configuring the org's AI provider requires the Manage Settings permission."
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="AI / Model"
      description="Choose and configure the AI provider that powers this org's agent"
    >
      <AiProviderPanel orgId={ctx.orgId} />
    </PageShell>
  );
}
