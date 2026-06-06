import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import {
  getOrgById,
  getActiveProjectCountForOrg,
  getActiveProjectsForOrg,
} from "@/lib/cache/queries";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Plus } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageShell } from "@/components/ui/page-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectsPortfolio } from "@/components/projects/project-card";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Instant-shell validation requires `await params` and any cookie reads
 * (e.g. `getAuthContext`) to live inside a <Suspense> boundary. The
 * synchronous default export ships a header skeleton; <HeaderAndContent>
 * awaits params + auth + org lookup behind that boundary.
 */
// unstable_instant temporarily removed — see [orgSlug]/page.tsx comment.

export default function ProjectsListPage({ params }: PageParams) {
  return (
    <Suspense fallback={<HeaderSkeleton />}>
      <HeaderAndContent params={params} />
    </Suspense>
  );
}

async function HeaderAndContent({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // Fast — single row by ID, cached via getOrgById.
  const org = await getOrgById(ctx.orgId);
  if (!org) notFound();

  return (
    <PageShell
      title="Projects"
      description={<ProjectsCountLine orgId={ctx.orgId} orgName={org.name} />}
      actions={
        <Link
          href={`/${orgSlug}/projects/new`}
          className={cn(buttonVariants(), "gap-2")}
        >
          <Plus className="h-4 w-4" /> New project
        </Link>
      }
    >
      <Suspense fallback={<ProjectGridSkeleton />}>
        <ProjectGrid orgId={ctx.orgId} orgSlug={orgSlug} />
      </Suspense>
    </PageShell>
  );
}

function HeaderSkeleton() {
  return (
    <div className="mx-auto max-w-7xl p-8">
      <div className="mb-8">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="mt-2 h-4 w-56" />
      </div>
      <ProjectGridSkeleton />
    </div>
  );
}

async function ProjectsCountLine({
  orgId,
  orgName,
}: {
  orgId: string;
  orgName: string;
}) {
  const count = await getActiveProjectCountForOrg(orgId);
  return (
    <>
      {count} active across {orgName}
    </>
  );
}

async function ProjectGrid({
  orgId,
  orgSlug,
}: {
  orgId: string;
  orgSlug: string;
}) {
  // Fetch the full set (including archived) so the client-side Active/Archived/
  // All filter can switch scope without a refetch. Rollups (item counts,
  // %complete, lead, active cycle, next due) come batched from the cache query.
  const projects = await getActiveProjectsForOrg(orgId, true);

  if (projects.length === 0) {
    return (
      <EmptyState
        title="No projects yet"
        description="Projects organize your work with boards, timelines, and dashboards."
        action={
          <Link
            href={`/${orgSlug}/projects/new`}
            className={cn(buttonVariants())}
          >
            + Create project
          </Link>
        }
      />
    );
  }

  return (
    <ProjectsPortfolio projects={projects} orgSlug={orgSlug} orgId={orgId} />
  );
}

function ProjectGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5"
        >
          <Skeleton className="mb-3 h-7 w-32" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="mt-3 h-3 w-40" />
        </div>
      ))}
    </div>
  );
}
