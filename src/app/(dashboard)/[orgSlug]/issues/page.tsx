import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { getOrgById } from "@/lib/cache/queries";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { IssuesView } from "@/components/work-items/issues-view";
import { Lock } from "lucide-react";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Org-wide Issues view — a JQL-lite cross-project work-item search. Per Cache
 * Components: `await params` + `getAuthContext` (cookie read) live INSIDE the
 * <Suspense> boundary; the synchronous default export ships a header skeleton.
 * The actual data load happens client-side (IssuesView's React Query).
 */
export default function IssuesPage({ params }: PageParams) {
  return (
    <Suspense fallback={<IssuesSkeleton />}>
      <IssuesPageContent params={params} />
    </Suspense>
  );
}

async function IssuesPageContent({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const org = await getOrgById(ctx.orgId);
  if (!org) notFound();

  const canRead = hasPermission(ctx.permissions, Permission.ITEM_READ);

  return (
    <PageShell
      title="Issues"
      description={`Search work items across every project in ${org.name}`}
    >
      {canRead ? (
        <IssuesView orgId={ctx.orgId} orgSlug={orgSlug} />
      ) : (
        <EmptyState
          illustration={<Lock className="mx-auto h-12 w-12 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden />}
          title="No access to issues"
          description="You don't have permission to read work items in this organization."
        />
      )}
    </PageShell>
  );
}

function IssuesSkeleton() {
  return (
    <div className="mx-auto max-w-7xl p-8">
      <div className="mb-6">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <Skeleton className="mb-4 h-14 w-full rounded-[var(--radius)]" />
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
        {[0, 1, 2, 3, 4, 5].map((i) => (
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
