import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { getOrgById } from "@/lib/cache/queries";
import { redirect, notFound } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { canViewPage } from "@/lib/nav/page-access";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { WorkItemsView } from "@/components/work-items/work-items-view";
import { Lock, Tag } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Org-wide Work Items view — a JQL-lite cross-project work-item search. Per Cache
 * Components: `await params` + `getAuthContext` (cookie read) live INSIDE the
 * <Suspense> boundary; the synchronous default export ships a header skeleton.
 * The actual data load happens client-side (WorkItemsView's React Query).
 */
export default function WorkItemsPage({ params }: PageParams) {
  return (
    <Suspense fallback={<WorkItemsSkeleton />}>
      <WorkItemsPageContent params={params} />
    </Suspense>
  );
}

async function WorkItemsPageContent({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const org = await getOrgById(ctx.orgId);
  if (!org) notFound();

  // Derived from the sidebar's own declaration rather than repeated here —
  // two copies of one rule is how the page and the nav drift apart.
  const canRead = canViewPage(ctx.permissions, "/work-items");

  return (
    <PageShell
      tourAnchor="issues"
      title="Work Items"
      description={`Search work items across every project in ${org.name}`}
      // The table is the page, and it is wide. In the default 7xl column it
      // scrolled sideways while a wide window sat empty beside it.
      maxWidth="full"
      // Labels are managed from here because this is where they are used and
      // filtered — a top-level nav entry for them would be a lot of chrome for
      // something you reach for while looking at issues.
      actions={
        canRead ? (
          <Link
            href={`/${orgSlug}/work-items/labels`}
            className={buttonVariants({ variant: "outline" })}
          >
            <Tag className="h-4 w-4" aria-hidden />
            Manage labels
          </Link>
        ) : undefined
      }
    >
      {canRead ? (
        <WorkItemsView orgId={ctx.orgId} orgSlug={orgSlug} />
      ) : (
        <EmptyState
          illustration={<Lock className="mx-auto h-12 w-12 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden />}
          title="No access to work items"
          description="You don't have permission to read work items in this organization."
        />
      )}
    </PageShell>
  );
}

/** Same box as the full-width PageShell above, so the page does not jump wider
 *  when it arrives. */
function WorkItemsSkeleton() {
  return (
    <div className="mx-auto max-w-full px-4 py-5 md:p-8">
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
