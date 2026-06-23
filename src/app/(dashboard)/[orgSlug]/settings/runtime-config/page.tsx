import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getAuthContext, getCurrentUser } from "@/lib/auth/session";
import { isInternalAdmin } from "@/lib/internal/access";
import { PageShell } from "@/components/ui/page-shell";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { RuntimeConfigPanel } from "@/components/settings/runtime-config-panel";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { NoAccess } from "@/components/settings/no-access";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Runtime config (design §8) — the GUI surface for per-tenant connector enablement, the
 * Nango breadth toggle, and the platform-owner tenantClass designation.
 *
 * Cache Components: `await params` + the cookie reads (getAuthContext / getCurrentUser via
 * isInternalAdmin) live INSIDE the <Suspense> boundary (<Gate>), so the static shell ships
 * immediately and the dynamic auth read is suspended. THIN: the API is the source of truth;
 * the panel just GET/PATCHes the runtime-config route. The platform-owner flip control is
 * rendered only when the viewer isInternalAdmin.
 */
export default function RuntimeConfigPage({ params }: PageParams) {
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
  if (!canViewSettings(ctx, "/settings/runtime-config")) {
    return (
      <PageShell title="Runtime config" description="Connectors, breadth & tenant class">
        <NoAccess what="runtime config" />
      </PageShell>
    );
  }

  // Platform-owner check — only an internal admin sees the tenantClass FLIP control.
  const user = await getCurrentUser();
  const platformOwner = !!user && isInternalAdmin(user.email, process.env.INTERNAL_ADMINS);

  return (
    <PageShell
      title="Runtime config"
      description="Per-tenant connector enablement, breadth, and the gov tenant-class designation"
    >
      <RuntimeConfigPanel orgId={ctx.orgId} isPlatformOwner={platformOwner} />
    </PageShell>
  );
}
