import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/session";
import { PageShell } from "@/components/ui/page-shell";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { PluginsPanel } from "@/components/settings/plugins-panel";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { NoAccess } from "@/components/settings/no-access";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Settings → Plugins (ADR 0003) — enable, disable, and configure org plugins.
 * Plugins are a fail-closed axis: nothing appears anywhere until it's switched on
 * here (or provisioned by the deployment's product profile at org creation).
 *
 * Cache Components: `await params` + the cookie read (getAuthContext) live INSIDE
 * the <Suspense> boundary (<Gate>), so the static shell ships immediately. THIN:
 * the API is the source of truth; the panel just GET/PATCHes the plugins routes.
 */
export default function PluginsPage({ params }: PageParams) {
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

  if (!canViewSettings(ctx, "/settings/plugins")) {
    return (
      <PageShell title="Plugins" description="Optional capability bundles for this organization">
        <NoAccess what="plugins" />
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Plugins"
      description="Optional capability bundles — enabled per organization, off until you opt in"
    >
      <PluginsPanel orgId={ctx.orgId} />
    </PageShell>
  );
}
