import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { countVisibleActiveProjects } from "@/lib/projects/visible-count";
import { getVisibleProjectIds } from "@/lib/rbac/project-access";
import {
  getOrgById,
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
import { RecentWindowPicker } from "@/components/projects/recent-window-picker";
import { recentProjectTouchesForUser } from "@/lib/projects/recent";
import {
  hoursForWindow,
  windowFromParam,
  type RecentWindowKey,
} from "@/lib/projects/recent-windows";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { StaggeredGrid } from "@/components/ui/staggered-grid";
import { Skeleton } from "@/components/ui/skeleton";
import { HomeDashboard } from "@/components/home/home-dashboard";
import { PluginSlot } from "@/components/plugins/plugin-slot";
import { formatDateStable } from "@/lib/format/stable-date";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
  /** `?recent=` picks the window for the project teaser. Read inside the
   *  Suspense boundary, like `params`, because it is a dynamic API. */
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

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

export default function OrgOverviewPage({ params, searchParams }: PageParams) {
  return (
    <Suspense fallback={<HeaderSkeleton />}>
      <HeaderAndContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function HeaderAndContent({ params, searchParams }: PageParams) {
  const { orgSlug } = await params;
  const sp = searchParams ? await searchParams : {};
  const recentWindow = windowFromParam(
    typeof sp.recent === "string" ? sp.recent : undefined,
  );
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // Single row by ID, cached via getOrgById.
  const org = await getOrgById(ctx.orgId);
  if (!org) notFound();

  return (
    <PageShell
      tourAnchor="overview"
      title={org.name}
      description={<MembersAndProjectsLine orgSlug={orgSlug} orgId={ctx.orgId} plan={org.plan} />}
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
        <StatCards orgSlug={orgSlug} orgId={ctx.orgId} plan={org.plan} />
      </Suspense>

      {/* Personal, customizable widget dashboard (client-rendered). */}
      <HomeDashboard orgId={ctx.orgId} />

      {/* Plugin overview.card slot — fail-closed: renders nothing unless an
          ENABLED plugin contributes here (e.g. Foreman's self-fetching pulse
          card, silent until an org has touched autonomous delivery). This is a
          client component, so this server page embeds it directly; enablement +
          the plugin's own fetching resolve on the client (no Suspense needed —
          no dynamic API is read here). */}
      <PluginSlot name="overview.card" orgId={ctx.orgId} />

      {/* "Recent" rather than "Active": the teaser exists to be a jumping-off
          point, and the org's active projects are a property of the org, not of
          you — so it could show six projects you never open (d5c10944). Recent
          means projects YOU have touched, newest first. */}
      <PageSection
        title="Recent projects"
        action={{ label: "View all", href: `/${orgSlug}/projects` }}
      >
        <div className="mb-3 flex justify-end">
          {/* Its own boundary: RecentWindowPicker reads `useSearchParams`, and
              a client hook that reads a dynamic API needs a Suspense ancestor
              under Cache Components. Omitting one is silent in dev, in CI and
              in the build, and only shows up in production. */}
          <Suspense fallback={null}>
            <RecentWindowPicker current={recentWindow} />
          </Suspense>
        </div>
        {/* Streaming section 2: project grid. */}
        <Suspense fallback={<ProjectGridSkeleton />}>
          <ProjectGrid
            orgId={ctx.orgId}
            orgSlug={orgSlug}
            userId={ctx.userId}
            windowKey={recentWindow}
          />
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
      <StatCardsSkeleton />
    </div>
  );
}

async function MembersAndProjectsLine({
  orgSlug,
  orgId,
  plan,
}: {
  orgSlug: string;
  orgId: string;
  plan: string;
}) {
  const [projectCount, memberCount] = await Promise.all([
    countVisibleActiveProjects(orgSlug, orgId),
    getOrgMemberCount(orgId),
  ]);
  return (
    <>
      {projectCount} projects · {memberCount} members · {plan.toLowerCase()} plan
    </>
  );
}

async function StatCards({
  orgSlug,
  orgId,
  plan,
}: {
  orgSlug: string;
  orgId: string;
  plan: string;
}) {
  const [activeProjects, members] = await Promise.all([
    countVisibleActiveProjects(orgSlug, orgId),
    getOrgMemberCount(orgId),
  ]);
  return (
    <div className="mb-10 grid grid-cols-1 gap-6 md:grid-cols-3">
      {/* No trend chip: there is nothing to compare against. It used to
          pass `+${activeProjects}` — the count again, with a plus in
          front — and TrendChip reads a leading "+" as upward, so a
          practice with twenty active projects was told it had gained
          twenty, permanently. A real trend needs a prior period, which
          this page does not read. */}
      <StatCard label="Active projects">
        <StatCard.Number>{activeProjects}</StatCard.Number>
      </StatCard>
      <StatCard label="Team members">
        <StatCard.Number>{members}</StatCard.Number>
      </StatCard>
      <StatCard label="Plan">
        <StatCard.Number>{plan}</StatCard.Number>
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
  userId,
  windowKey,
}: {
  orgId: string;
  orgSlug: string;
  userId: string;
  windowKey: RecentWindowKey;
}) {
  // Cached fetch returns the full active set; slice to the first 6 for the
  // Overview teaser. Slicing client-side from a cached array is cheaper than
  // a second uncached query.
  const allProjects = await getActiveProjectsForOrg(orgId);
  // getActiveProjectsForOrg is `"use cache"` keyed per ORG, so it cannot filter
  // by actor without either leaking one user's view to another or destroying the
  // cache. Keep the cached org-wide query, then narrow per request.
  const listCtx = await getAuthContext(orgSlug);
  const visibleIds = listCtx
    ? await getVisibleProjectIds(listCtx, allProjects.map((p) => p.id))
    : new Set<string>();
  const visible = allProjects.filter((p) => visibleIds.has(p.id));

  // The per-user half, uncached on purpose — see recentProjectTouchesForUser.
  const touched = await recentProjectTouchesForUser(
    orgId,
    userId,
    hoursForWindow(windowKey),
  );
  const recent = visible
    .filter((p) => touched.has(p.id))
    .sort((a, b) => touched.get(b.id)!.getTime() - touched.get(a.id)!.getTime());

  // Nothing touched in the window — a new member, or a quiet week. Fall back to
  // the active list rather than showing an empty teaser, and say so, so the
  // projects on screen are never unexplained.
  const fellBack = recent.length === 0 && visible.length > 0;
  const projects = (fellBack ? visible : recent).slice(0, 6);

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
    <>
      {fellBack && (
        <p className="mb-3 text-xs text-[var(--text-muted)]">
          Nothing touched in this window — showing the project&rsquo;s active
          list instead.
        </p>
      )}
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
            Updated {formatDateStable(p.updatedAt)}
          </p>
        </Link>
      ))}
    </StaggeredGrid>
    </>
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
