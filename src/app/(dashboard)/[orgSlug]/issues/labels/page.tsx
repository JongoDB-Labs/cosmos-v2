import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { getOrgById } from "@/lib/cache/queries";
import { redirect, notFound } from "next/navigation";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { LabelsManager } from "@/components/work-items/labels-manager";
import { Lock } from "lucide-react";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Org-wide label management, alongside Issues because that is where labels are
 * used and filtered. Same Cache Components shape as the Issues page: `await
 * params` + the cookie read live inside <Suspense>, data loads client-side.
 */
export default function LabelsPage({ params }: PageParams) {
  return (
    <Suspense fallback={<LabelsSkeleton />}>
      <LabelsPageContent params={params} />
    </Suspense>
  );
}

async function LabelsPageContent({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const org = await getOrgById(ctx.orgId);
  if (!org) notFound();

  const canRead = hasPermission(ctx.permissions, Permission.ITEM_READ);

  return (
    <PageShell
      title="Labels"
      description={`Every label in ${org.name}, and what uses it`}
    >
      {canRead ? (
        <LabelsManager orgId={ctx.orgId} />
      ) : (
        <EmptyState
          illustration={
            <Lock className="mx-auto h-12 w-12 text-[var(--text-muted)]" strokeWidth={1.5} aria-hidden />
          }
          title="No access to labels"
          description="You don't have permission to read work items in this organization."
        />
      )}
    </PageShell>
  );
}

function LabelsSkeleton() {
  return (
    <div className="mx-auto max-w-7xl p-8">
      <div className="mb-6">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <Skeleton className="mb-4 h-10 w-64 rounded-[var(--radius)]" />
      <div className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-[var(--radius)]" />
        ))}
      </div>
    </div>
  );
}
