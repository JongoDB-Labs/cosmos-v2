import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { getOrgById } from "@/lib/cache/queries";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { UpdatesFeed } from "@/components/work-items/updates-feed";
import { Lock } from "lucide-react";

type PageParams = { params: Promise<{ orgSlug: string }> };

// NB: no `unstable_instant` export — instant-nav is disabled project-wide while
// the Next 16.2 Turbopack build-validation bug is investigated (see the org
// overview page). Model this route after the Issues page, which ships none.

/**
 * Org-wide "latest updates" feed (FR 8aa3c0e0). Same Cache-Components shape as
 * the Issues page: `await params` + cookie-reading `getAuthContext` live inside
 * the <Suspense> boundary; the data load itself is client-side (React Query).
 */
export default function ActivityPage({ params }: PageParams) {
  return (
    <Suspense fallback={<ActivitySkeleton />}>
      <ActivityPageContent params={params} />
    </Suspense>
  );
}

async function ActivityPageContent({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const org = await getOrgById(ctx.orgId);
  if (!org) notFound();

  const canRead = hasPermission(ctx.permissions, Permission.ITEM_READ);

  return (
    <PageShell
      title="Activity"
      description={`The latest work-item activity across every project in ${org.name}`}
    >
      {canRead ? (
        <UpdatesFeed orgId={ctx.orgId} orgSlug={orgSlug} />
      ) : (
        <EmptyState
          illustration={<Lock className="mx-auto h-12 w-12 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden />}
          title="No access to activity"
          description="You don't have permission to read work items in this organization."
        />
      )}
    </PageShell>
  );
}

function ActivitySkeleton() {
  return (
    <div className="mx-auto max-w-4xl p-8">
      <div className="mb-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="mt-2 h-4 w-80" />
      </div>
      <Skeleton className="mb-4 h-10 w-full rounded-[var(--radius)]" />
      <div className="space-y-3">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
