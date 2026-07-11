import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import {
  getOrgById,
  getActiveProjectCountForOrg,
  getActiveProjectsForOrg,
  getOrgMemberCount,
} from "@/lib/cache/queries";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { Plus } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageShell } from "@/components/ui/page-shell";
import { PageSection } from "@/components/ui/page-section";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { StaggeredGrid } from "@/components/ui/staggered-grid";
import { Skeleton } from "@/components/ui/skeleton";
import { HomeDashboard } from "@/components/home/home-dashboard";
import { ForemanPulseCard } from "@/components/foreman/foreman-pulse-card";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Instant-shell validation requires `await params` and any cookie reads
 * (e.g. `getAuthContext`) to live inside a <Suspense> boundary. The
 * synchronous default export ships a header skeleton in the static shell;
 * <HeaderAndContent> awaits params + auth + org lookup behind that
 * boundary, with nested Suspense boundaries for StatCards and ProjectGrid
 * so they stream independently.
 */
// unstable_instant temporarily removed — instant-nav disabled while the
// Next.js 16.2.6 Turbopack build validation bug is investigated.
// To re-enable: restore the export with `prefetch: "static"`, samples, and
// unstable_disableBuildValidation: true.

export default function OrgOverviewPage({ params }: PageParams) {
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

  // Single row by ID, cached via getOrgById.
  const org = await getOrgById(ctx.orgId);
  if (!org) notFound();

  return (
    <PageShell
      title={org.name}
      description={<MembersAndProjectsLine orgId={ctx.orgId} plan={org.plan} />}
      actions={
        <Link
          href={`/${orgSlug}/projects/new`}
          className={cn(buttonVariants(), "gap-2")}
        >
          <Plus className="h-4 w-4" /> New project
        </Link>
      }
    >
      {/* Streaming section 1: KPI cards. */}
      <Suspense fallback={<StatCardsSkeleton />}>
        <StatCards orgId={ctx.orgId} />
      </Suspense>

      {/* Personal, customizable widget dashboard (client-rendered). */}
      <HomeDashboard orgId={ctx.orgId} />

      {/* Foreman pulse — self-fetching client card; renders nothing until
          this org has enabled autonomous delivery or has prior history, so
          it's silent for orgs that have never touched it. No Suspense
          wrapper needed (see AGENTS.md's Cache Components note — this reads
          no dynamic APIs itself, it's a client component that fetches after
          mount). */}
      <ForemanPulseCard orgId={ctx.orgId} />

      <PageSection
        title="Active projects"
        action={{ label: "View all", href: `/${orgSlug}/projects` }}
      >
        {/* Streaming section 2: project grid. */}
        <Suspense fallback={<ProjectGridSkeleton />}>
          <ProjectGrid orgId={ctx.orgId} orgSlug={orgSlug} />
        </Suspense>
      </PageSection>
    </PageShell>
  );
}

function HeaderSkeleton() {
  return (
    <div className="mx-auto max-w-7xl p-8">
      <div className="mb-8">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6"
          >
            <Skeleton className="mb-3 h-3 w-24" />
            <Skeleton className="h-8 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

async function MembersAndProjectsLine({
  orgId,
  plan,
}: {
  orgId: string;
  plan: string;
}) {
  const [projectCount, memberCount] = await Promise.all([
    getActiveProjectCountForOrg(orgId),
    getOrgMemberCount(orgId),
  ]);
  return (
    <>
      {projectCount} projects · {memberCount} members · {plan.toLowerCase()} plan
    </>
  );
}

async function StatCards({ orgId }: { orgId: string }) {
  const [activeProjects, members, org] = await Promise.all([
    getActiveProjectCountForOrg(orgId),
    getOrgMemberCount(orgId),
    getOrgById(orgId),
  ]);
  const plan = org ? { plan: org.plan } : null;
  return (
    <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-3">
      <StatCard label="Active projects" trend={`+${activeProjects}`}>
        <StatCard.Number>{activeProjects}</StatCard.Number>
      </StatCard>
      <StatCard label="Team members">
        <StatCard.Number>{members}</StatCard.Number>
      </StatCard>
      <StatCard label="Plan">
        <StatCard.Number>{plan?.plan ?? "—"}</StatCard.Number>
      </StatCard>
    </div>
  );
}

function StatCardsSkeleton() {
  return (
    <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-6"
        >
          <Skeleton className="mb-3 h-3 w-24" />
          <Skeleton className="h-8 w-20" />
        </div>
      ))}
    </div>
  );
}

async function ProjectGrid({
  orgId,
  orgSlug,
}: {
  orgId: string;
  orgSlug: string;
}) {
  // Cached fetch returns the full active set; slice to the first 6 for the
  // Overview teaser. Slicing client-side from a cached array is cheaper than
  // a second uncached query.
  const allProjects = await getActiveProjectsForOrg(orgId);
  const projects = allProjects.slice(0, 6);

  if (projects.length === 0) {
    return (
      <EmptyState
        title="No projects yet"
        description="Create your first project to start tracking work."
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
    <StaggeredGrid className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {projects.map((p) => (
        <Link
          key={p.id}
          href={`/${orgSlug}/projects/${p.key}`}
          className="block rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5 transition-shadow hover:shadow-[var(--shadow-glow)]"
        >
          <div className="mb-3 flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-[var(--primary-tint)] flex items-center justify-center text-xs font-semibold text-[var(--primary)]">
              {p.name.charAt(0).toUpperCase()}
            </div>
            <h3 className="font-medium truncate">{p.name}</h3>
          </div>
          <Badge variant="progress">Active</Badge>
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Updated {new Date(p.updatedAt).toLocaleDateString()}
          </p>
        </Link>
      ))}
    </StaggeredGrid>
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
