import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { DashboardShell } from "@/components/layouts/dashboard-shell";
import { isInternalAdmin } from "@/lib/internal/access";
import { CommandPalette } from "@/components/search/command-palette";
import { QueryProvider } from "@/components/providers/query-provider";
import { PermissionsProvider } from "@/components/providers/permissions-provider";
import { BackgroundProvider } from "@/components/providers/background-provider";
import { BugReporter } from "@/components/telemetry/bug-reporter";
import { PageTransition } from "@/components/ui/page-transition";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";

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
    select: { bgDarkUrl: true, bgLightUrl: true },
  });

  const orgs = user.memberships.map((m) => ({
    id: m.org.id,
    name: m.org.name,
    slug: m.org.slug,
    plan: m.org.plan,
    logoUrl: m.org.logoUrl,
    role: m.role,
  }));

  return (
    <PermissionsProvider orgs={orgs}>
      <BackgroundProvider darkUrl={prefs?.bgDarkUrl} lightUrl={prefs?.bgLightUrl} />
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
        <PageTransition>{children}</PageTransition>
        <CommandPalette orgs={orgs} />
      </DashboardShell>
    </PermissionsProvider>
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
