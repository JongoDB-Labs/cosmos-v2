import { Suspense } from "react";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { PmDashboard } from "@/components/pm-dashboard/pm-dashboard";
import { loadMilestonesWithDerived } from "@/lib/pm/schedule";
import { loadKpisWithDerived } from "@/lib/pm/kpi-derive";
import { loadClinsWithBurn } from "@/lib/pm/burn";
import { canViewPage } from "@/lib/nav/page-access";
import { getVisibleProjectIds } from "@/lib/rbac/project-access";
import { hasAnyPermission, Permission } from "@/lib/rbac/permissions";
import { NoPageAccess } from "@/components/ui/no-page-access";
import { PageShell, pageShellBoxClassName, type PageShellProps } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { HardHat } from "lucide-react";
import { headers } from "next/headers";
import { connection } from "next/server";
import { publicOriginFromHeaders } from "@/lib/auth/public-url";
import {
  programManagementEmbedUrl,
  programManagementSameSiteOrigin,
  programManagementSignInUrl,
} from "@/lib/pm/embed";
import { ProjectPicker } from "./project-picker";
import { EmbeddedDashboard } from "./embedded-dashboard";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ project?: string }>;
};

/**
 * Program Management — the one place program work is read across the org.
 *
 * It replaces the org-wide PM Dashboard roll-up at /pm-dashboard (which
 * redirects here) and is the destination for the per-project PM Dashboard tab,
 * which is no longer offered on new projects. The rest of that migration --
 * folding the registers into the unified work-item ontology so a deliverable,
 * a milestone and a risk are one kind of record rather than six tables -- is
 * still ahead of us, which is what the notice below says out loud rather than
 * leaving the page to imply it is finished.
 *
 * Scope is a project picker, not a URL segment, because the question this page
 * answers ("how is the program doing") is asked of the portfolio as often as
 * of one project, and a segment forces a choice before the page can load.
 *
 * Cache Components: `params`, `searchParams` and the cookie read in
 * `getAuthContext` all live inside the <Suspense> boundary below. Awaiting any
 * of them in the default export breaks instant validation.
 */
export default function ProgramManagementPage({ params, searchParams }: PageParams) {
  return (
    <Suspense fallback={null}>
      <ProgramManagementLoading params={params} searchParams={searchParams} />
    </Suspense>
  );
}

/**
 * The skeleton must sit in the box the page arrives in, and that box depends on
 * the instance's PROGRAM_MANAGEMENT_EMBED_URL. A framed dashboard spans the
 * window, and the built-in page uses the default column. With one fixed
 * skeleton, an instance with a framed dashboard loaded narrow and then jumped
 * wide.
 *
 * `connection()` comes first because, under Cache Components, a plain
 * `process.env` read can be fixed at build time (see root-brand-provider.tsx),
 * and images are built without this variable. The dashboard layout already
 * reads the session above this page, so the page renders per request anyway.
 * This only makes the setting a request-time read.
 */
async function ProgramManagementLoading({ params, searchParams }: PageParams) {
  await connection();
  const embedded = programManagementEmbedUrl() !== null;
  return (
    <Suspense fallback={<ProgramManagementSkeleton embedded={embedded} />}>
      <ProgramManagementContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

/** The page's width, read by the page and its skeleton alike so they cannot disagree. */
function pageWidth(embedded: boolean): NonNullable<PageShellProps["maxWidth"]> {
  return embedded ? "full" : "7xl";
}

/**
 * Exported for its test only. Next treats the DEFAULT export as the page, so a
 * named export here changes nothing at runtime -- but it lets the test drive
 * the component that actually reads auth, scope and permissions, rather than
 * the Suspense shell, which has no behaviour to assert.
 */
export async function ProgramManagementContent({ params, searchParams }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // Derived from the sidebar's own declaration rather than restated here --
  // two copies of one rule is how a page and its nav entry drift apart.
  if (!canViewPage(ctx.permissions, "/program-management")) {
    return (
      // The skeleton's width, so the notice does not arrive in a narrower box.
      <PageShell title="Program Management" maxWidth={pageWidth(programManagementEmbedUrl() !== null)}>
        <NoPageAccess what="program management" />
      </PageShell>
    );
  }

  // An instance can show an outside dashboard here instead, while the
  // built-in page catches up (src/lib/pm/embed.ts). After the access check on
  // purpose: the frame is still this page, and who may open it does not
  // change because its content comes from elsewhere. Nothing below is loaded
  // for it -- the registers would be queried only to be thrown away.
  const embed = programManagementEmbedUrl();
  if (embed) {
    // Opened at an address on another site than the dashboard, the frame can
    // never be signed in, and every sign-in loops back to its sign-in page.
    // Go to this instance's address that shares the dashboard's site, when it
    // has one (src/lib/pm/embed.ts).
    const here = publicOriginFromHeaders(await headers());
    const there = here ? programManagementSameSiteOrigin(here) : null;
    if (there) redirect(`${there}/${encodeURIComponent(orgSlug)}/program-management`);
    return (
      <PageShell tourAnchor="program-management" title="Program Management" maxWidth={pageWidth(true)}>
        <EmbeddedDashboard src={embed.href} signInSrc={programManagementSignInUrl()?.href ?? embed.href} />
      </PageShell>
    );
  }

  const org = await prisma.organization.findUnique({
    where: { id: ctx.orgId },
    select: { name: true },
  });
  if (!org) notFound();

  // Every project the viewer may see, narrowed exactly as the Projects list
  // narrows it: a team-restricted project they are not on is absent from the
  // picker AND from every total below, not merely hidden from the dropdown.
  const all = await prisma.project.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { name: "asc" },
    select: { id: true, key: true, name: true },
  });
  const visibleIds = new Set(await getVisibleProjectIds(ctx, all.map((p) => p.id)));
  const visibleProjects = all.filter((p) => visibleIds.has(p.id));

  // An unknown or unreadable ?project= falls back to the whole portfolio
  // rather than erroring: the key is in a URL people paste, and a project can
  // be renamed, archived or put behind a team after the link was shared.
  const requestedKey = (await searchParams).project ?? null;
  const selected = requestedKey
    ? (visibleProjects.find((p) => p.key === requestedKey) ?? null)
    : null;
  const selectedKey = selected?.key ?? null;

  const scopeIds = selected ? [selected.id] : visibleProjects.map((p) => p.id);

  // Money is gated separately from the page. Reading that a program has
  // slipped is a different question from reading what it is worth, and the
  // people who need the first are not always cleared for the second -- which
  // is the same split Accounting already makes.
  const canSeeMoney = hasAnyPermission(
    ctx.permissions,
    Permission.FINANCE_READ,
    Permission.ACCOUNTING_READ,
  );

  const where = { orgId: ctx.orgId, projectId: { in: scopeIds } };
  const [milestones, kpis, goals, risks, deliverables, blockers, changes, clins] =
    await Promise.all([
      // Milestone status + completion derive from linked work items.
      loadMilestonesWithDerived(ctx.orgId, scopeIds),
      // KPI currentValue derives from execution for auto-source KPIs.
      loadKpisWithDerived(ctx.orgId, scopeIds),
      prisma.goal.findMany({
        where,
        orderBy: { sortOrder: "asc" },
        select: { id: true, title: true, status: true, progress: true },
      }),
      prisma.risk.findMany({
        where: { ...where, status: { not: "CLOSED" } },
        orderBy: { score: "desc" },
        select: { id: true, code: true, title: true, level: true, status: true, score: true, escalate: true },
      }),
      prisma.deliverable.findMany({
        where,
        orderBy: { baselineDue: "asc" },
        select: { id: true, code: true, title: true, status: true, baselineDue: true, clin: true },
      }),
      prisma.blocker.findMany({
        where: { ...where, status: "OPEN" },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          code: true,
          title: true,
          type: true,
          status: true,
          whatUnblocks: true,
          escalate: true,
          customerNotified: true,
        },
      }),
      prisma.changeRequest.findMany({
        where,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          code: true,
          title: true,
          type: true,
          status: true,
          costImpact: true,
          scheduleDaysImpact: true,
        },
      }),
      // Not even queried without the permission: CLIN burn is contract value
      // and funding, and the cheapest way to keep it out of a payload is to
      // never load it.
      canSeeMoney ? loadClinsWithBurn(ctx.orgId, scopeIds) : Promise.resolve([]),
    ]);

  return (
    <PageShell
      tourAnchor="program-management"
      title="Program Management"
      maxWidth={pageWidth(false)}
      description={
        selected
          ? `${selected.name} — schedule, risk and delivery`
          : `Every project in ${org.name} you can see — schedule, risk and delivery`
      }
      actions={
        <ProjectPicker orgSlug={orgSlug} projects={visibleProjects} selectedKey={selectedKey} />
      }
    >
      <UnderConstruction />
      <PmDashboard
        // The PageShell above already carries the title and says what is in
        // scope, so this component does not repeat either.
        hideScopeHeading
        moneyWithheld={!canSeeMoney}
        scope={{ kind: "org", orgId: ctx.orgId, orgName: selected ? selected.name : org.name }}
        data={{
          milestones: milestones.map((m) => ({
            id: m.id,
            title: m.title,
            status: m.status,
            dueDate: m.dueDate.toISOString(),
            actualDate: m.actualDate ? m.actualDate.toISOString() : null,
            completionPercent: m.completionPercent,
          })),
          kpis: kpis.map((k) => ({
            id: k.id,
            name: k.name,
            unit: k.unit,
            targetValue: k.targetValue,
            currentValue: k.currentValue,
            direction: k.direction,
            derived: k.derived,
          })),
          goals,
          risks,
          deliverables: deliverables.map((d) => ({
            id: d.id,
            code: d.code,
            title: d.title,
            status: d.status,
            clin: d.clin,
            baselineDue: d.baselineDue ? d.baselineDue.toISOString() : null,
          })),
          blockers,
          changes: changes.map((c) => ({
            id: c.id,
            code: c.code,
            title: c.title,
            type: c.type,
            status: c.status,
            // A change request's SCHEDULE impact is program information; its
            // COST impact is financial, so it is withheld rather than the
            // whole row being dropped -- the slip is still worth seeing.
            costImpact: canSeeMoney && c.costImpact != null ? Number(c.costImpact) : null,
            scheduleDaysImpact: c.scheduleDaysImpact,
          })),
          clins: clins.map((c) => ({
            id: c.id,
            code: c.code,
            title: c.title,
            value: c.value,
            burned: c.burned,
            percentConsumed: c.percentConsumed,
          })),
        }}
      />
    </PageShell>
  );
}

/**
 * Says plainly that this page is mid-migration. It is here because the page
 * already shows real figures: without it, a reader has no way to tell that the
 * registers behind these panels are about to be rebuilt, and would reasonably
 * read "no deliverables" as "none exist" rather than "not migrated yet".
 */
function UnderConstruction() {
  return (
    <div
      role="note"
      className="mb-6 flex items-start gap-3 rounded-[var(--radius)] border border-[var(--border)] border-l-4 border-l-[var(--status-progress)] bg-[var(--surface)] p-4"
    >
      {/* --status-progress-text, not --status-progress: the fill tier is a
          background colour and fails contrast as a foreground. */}
      <HardHat className="mt-0.5 h-5 w-5 shrink-0 text-[var(--status-progress-text)]" aria-hidden />
      <div className="text-sm">
        <p className="font-medium text-[var(--text)]">Under construction</p>
        <p className="mt-1 text-[var(--text-muted)]">
          This page is replacing the per-project PM Dashboard. The figures below are live, but the
          registers behind them — deliverables, risks, blockers, change requests and CLINs — are
          being folded into the same work-item model as everything else, so what is shown here will
          grow. Nothing has been deleted: existing projects keep their PM Dashboard tab until the
          move is finished.
        </p>
      </div>
    </div>
  );
}

/**
 * Laid out in the PageShell box the page arrives in (see pageWidth), and shaped
 * like the content for each mode: the framed dashboard has only a title, a
 * toolbar and the frame, so its skeleton promises no picker and no panels.
 */
function ProgramManagementSkeleton({ embedded }: { embedded: boolean }) {
  if (embedded) {
    return (
      <div className={pageShellBoxClassName(pageWidth(true))}>
        <Skeleton className="mb-5 h-8 w-64 md:mb-8" />
        <div className="flex flex-col gap-3">
          <div className="flex justify-end gap-2">
            <Skeleton className="h-7 w-7" />
            <Skeleton className="h-7 w-32" />
          </div>
          {/* The frame's size, from embedded-dashboard.tsx. */}
          <Skeleton className="h-[calc(100dvh-13rem)] min-h-[32rem] w-full rounded-[var(--radius)]" />
        </div>
      </div>
    );
  }
  return (
    <div className={pageShellBoxClassName(pageWidth(false))}>
      <div className="mb-5 flex items-start justify-between gap-4 md:mb-8">
        <div className="min-w-0">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="mt-2 h-4 w-96" />
        </div>
        <Skeleton className="h-9 w-56" />
      </div>
      <Skeleton className="mb-6 h-20 w-full rounded-[var(--radius)]" />
      <div className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-32 w-full rounded-[var(--radius)]" />
        ))}
      </div>
    </div>
  );
}
