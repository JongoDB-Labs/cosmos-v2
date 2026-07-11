import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { getOrgById } from "@/lib/cache/queries";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { DashboardsView } from "@/components/dashboards/dashboards-view";
import { Lock } from "lucide-react";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Custom Dashboards (COSMOS-87) — saved, named, filterable views of work items
 * you can quick-switch between (e.g. a "Standup" dashboard). Per Cache
 * Components: `await params` + `getAuthContext` (cookie read) live INSIDE the
 * <Suspense> boundary; the synchronous default export ships a skeleton. The data
 * load happens client-side (DashboardsView's React Query).
 */
export default function DashboardsPage({ params }: PageParams) {
  return (
    <Suspense fallback={<DashboardsSkeleton />}>
      <DashboardsPageContent params={params} />
    </Suspense>
  );
}

async function DashboardsPageContent({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const org = await getOrgById(ctx.orgId);
  if (!org) notFound();

  const canRead = hasPermission(ctx.permissions, Permission.ITEM_READ);

  return (
    <PageShell
      title="Dashboards"
      description="Save filtered views of your work items and switch between them — handy for standups and reviews"
    >
      {canRead ? (
        <DashboardsView orgId={ctx.orgId} orgSlug={orgSlug} />
      ) : (
        <EmptyState
          illustration={<Lock className="mx-auto h-12 w-12 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden />}
          title="No access to dashboards"
          description="You don't have permission to read work items in this organization."
        />
      )}
    </PageShell>
  );
}

function DashboardsSkeleton() {
  return (
    <div className="mx-auto max-w-7xl p-8">
      <div className="mb-6">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="mt-2 h-4 w-96" />
      </div>
      <div className="mb-4 flex gap-2">
        <Skeleton className="h-9 w-40 rounded-[var(--radius)]" />
        <Skeleton className="h-9 w-40 rounded-[var(--radius)]" />
      </div>
      <Skeleton className="mb-6 h-14 w-full rounded-[var(--radius)]" />
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-[var(--border)] p-4 last:border-b-0"
          >
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-6 w-6 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
