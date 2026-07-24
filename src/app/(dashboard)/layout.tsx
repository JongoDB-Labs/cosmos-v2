import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { DashboardShell } from "@/components/layouts/dashboard-shell";
import { isInternalAdmin } from "@/lib/internal/access";
import { getEnabledModulesByOrg } from "@/lib/entitlements";
import { getEnabledPluginsByOrg } from "@/lib/plugins/enablement";
import { PluginEnablementProvider } from "@/components/plugins/plugin-slot";
import "@/lib/plugins/registry/index";
import { CommandPalette } from "@/components/search/command-palette";
import { QueryProvider } from "@/components/providers/query-provider";
import { PermissionsProvider } from "@/components/providers/permissions-provider";
import { BackgroundProvider } from "@/components/providers/background-provider";
import { ApplySavedSkin } from "@/components/settings/apply-saved-skin";
import { BugReporter } from "@/components/telemetry/bug-reporter";
import { PageTransition } from "@/components/ui/page-transition";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { resolveBrand, pickOrgBrand } from "@/lib/brand";
import { BrandProvider } from "@/components/providers/brand-provider";

/**
 * Cache Components requires that any cookie/header read happen inside a
 * <Suspense> boundary. The auth + user-data fetch lives in <AuthedShell>
 * below, wrapped in Suspense so the shell skeleton ships in the static
 * shell while the real chrome streams in once cookies resolve.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <QueryProvider>
      <Suspense fallback={<DashboardLayoutFallback />}>
        <AuthedShell>{children}</AuthedShell>
      </Suspense>
      <Toaster position="top-right" richColors />
    </QueryProvider>
  );
}

async function AuthedShell({ children }: { children: React.ReactNode }) {
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: currentUser.id },
    include: {
      memberships: {
        include: { org: true },
      },
    },
  });

  if (!user) redirect("/login");

  const prefs = await prisma.userPreferences.findUnique({
    where: { userId: user.id },
    select: { bgDarkUrl: true, bgLightUrl: true, skinId: true },
  });

  const orgIds = user.memberships.map((m) => m.org.id);
  const [moduleMap, pluginMap] = await Promise.all([
    getEnabledModulesByOrg(orgIds),
    getEnabledPluginsByOrg(orgIds),
  ]);

  const orgs = user.memberships.map((m) => ({
    id: m.org.id,
    name: m.org.name,
    slug: m.org.slug,
    plan: m.org.plan,
    logoUrl: m.org.logoUrl,
    role: m.role,
    enabledModules: moduleMap.get(m.org.id) ?? null,
    enabledPlugins: pluginMap.get(m.org.id) ?? [],
    // Walkthrough/demo tenants (seeded by demo-defense) carry settings.isDemo so
    // the shell can show a "demo data" banner and the data reads as deletable.
    isDemo:
      typeof m.org.settings === "object" &&
      m.org.settings !== null &&
      (m.org.settings as Record<string, unknown>).isDemo === true,
  }));

  // Seed the brand from the user's sole org when unambiguous. (No synchronous
  // URL read is possible here under Cache Components, and no x-pathname header
  // is published — verified against origin/main.) Multi-org accounts fall back
  // to the deployment brand for the pre-paint seed; the sidebar still shows the
  // correct per-org name via currentOrg props. resolveBrand(null) === getBrand().
  const soleOrg = user.memberships.length === 1 ? user.memberships[0]?.org : undefined;
  const brand = resolveBrand(pickOrgBrand(soleOrg));
  const orgDefaultSkinId = soleOrg?.defaultSkinId ?? null;

  return (
    <BrandProvider value={brand}>
      <PermissionsProvider orgs={orgs}>
        <BackgroundProvider darkUrl={prefs?.bgDarkUrl} lightUrl={prefs?.bgLightUrl} />
        <ApplySavedSkin skinId={prefs?.skinId ?? null} orgDefaultSkinId={orgDefaultSkinId} />
        <BugReporter />
        <DashboardShell
          user={{
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            avatarUrl: user.avatarUrl,
          }}
          orgs={orgs}
          isSystemAdmin={isInternalAdmin(user.email, process.env.INTERNAL_ADMINS)}
        >
          {/* Seeds the fail-closed enabled-plugins context that <PluginSlot>
              reads (per-org, from the shell data + URL). Must wrap every page
              that embeds a plugin slot (overview card, work-item badge, …). */}
          <PluginEnablementProvider orgs={orgs}>
            <PageTransition>{children}</PageTransition>
          </PluginEnablementProvider>
          <CommandPalette orgs={orgs} />
        </DashboardShell>
      </PermissionsProvider>
    </BrandProvider>
  );
}

/**
 * Minimal chrome shown while auth resolves. We don't have user/orgs data
 * yet, so the sidebar and topbar render as skeletons. Auth is ~1-2 DB
 * queries — users see the real shell within tens of milliseconds.
 */
// A PURE static skeleton — it must NOT render {children}. Rendering the page
// tree (with its own dynamic Suspense boundaries) inside this fallback AND again
// inside the resolved <AuthedShell> double-mounts those boundaries; under
// streaming the fallback's copy "can't finish" and React recovers by switching
// to client rendering → the recoverable hydration error #419 on every page.
// The page streams in with the authed shell once cookies resolve.
function DashboardLayoutFallback() {
  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg)]">
      <aside className="hidden md:block w-64 border-r border-[var(--border)] bg-[image:var(--sidebar-gradient)]">
        <div className="p-4">
          <Skeleton className="h-6 w-24" />
        </div>
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center border-b border-[var(--border)] px-4">
          <Skeleton className="h-6 w-32" />
        </header>
        <main className="flex-1 overflow-y-auto p-8">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-4 h-4 w-full max-w-2xl" />
          <Skeleton className="mt-2 h-4 w-full max-w-xl" />
        </main>
      </div>
    </div>
  );
}
