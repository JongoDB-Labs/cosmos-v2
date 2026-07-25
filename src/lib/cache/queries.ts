/**
 * Data-layer cache helpers for high-traffic read paths.
 *
 * Uses the Next.js 16 Cache Components `"use cache"` directive (enabled by
 * `cacheComponents: true` in next.config.ts). Each helper has a `cacheLife`
 * for its expected freshness and a `cacheTag` keyed by the resource id/slug
 * so we can target-invalidate exactly the affected entry.
 *
 * Invalidation:
 *   Every cached helper is tagged. After a mutation that touches the
 *   relevant data, call the matching `revalidate*` helper (e.g.
 *   `revalidateOrg({ id, slug })`) to expire the entry.
 */
import { cacheLife, cacheTag, revalidateTag } from "next/cache";
import { prisma } from "@/lib/db/client";

// ---------------------------------------------------------------------------
// Organization lookups
// ---------------------------------------------------------------------------

/**
 * Look up an org by slug. Hot — used by `getAuthContext` and any UI that
 * needs to resolve a URL `[orgSlug]` segment into a concrete org.
 */
export async function getOrgBySlug(slug: string) {
  "use cache";
  cacheLife("hours");
  cacheTag(`org-slug:${slug}`);
  return prisma.organization.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      plan: true,
      themePrimary: true,
    },
  });
}

/**
 * Look up an org by id. Used in dashboard pages and many API handlers that
 * already have the org id from `getAuthContext`.
 */
export async function getOrgById(id: string) {
  "use cache";
  cacheLife("hours");
  cacheTag(`org:${id}`);
  return prisma.organization.findUnique({
    where: { id },
    select: {
      id: true,
      slug: true,
      name: true,
      plan: true,
      themePrimary: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Project lookups
// ---------------------------------------------------------------------------

/**
 * Per-project portfolio rollup. Returned alongside the base project fields by
 * `getActiveProjectsForOrg` so the Projects list can render a real status
 * (progress bar, item counts, lead, active interval, next due) instead of a
 * hard-coded "Active" badge. Extends the previous shape additively — existing
 * callers (e.g. the Org Overview teaser) only read id/key/name/updatedAt.
 */
export interface ProjectRollup {
  id: string;
  key: string;
  name: string;
  archived: boolean;
  updatedAt: Date;
  /** Total non-deleted work items in the project. */
  totalItems: number;
  /** Work items considered "done" — i.e. `completedAt` is set (the same signal
   *  the board/AI executors use when an item enters a done/completed/closed
   *  column). */
  doneItems: number;
  /** Math.round(doneItems / totalItems * 100); 0 when there are no items. */
  percentComplete: number;
  /** Project lead/owner (LEAD, else MANAGER) if one is assigned. */
  lead: { displayName: string; avatarUrl: string | null } | null;
  /** Name of the single ACTIVE interval, if any. */
  activeIntervalName: string | null;
  /** Earliest upcoming (>= now) due date among incomplete work items. */
  nextDueDate: Date | null;
}

/**
 * Active projects for an org, enriched with portfolio rollups. Used by the Org
 * Overview teaser and the Projects list.
 *
 * Efficiency: a fixed set of batched queries (no N+1). Rather than one query
 * per project, we run the base `findMany` then three `groupBy` aggregates over
 * WorkItem (total count, done count, min upcoming due date) plus two scoped
 * `findMany`s (active intervals, project leads) — all keyed by `projectId IN (…)`
 * — and stitch them together in memory. Query count is constant regardless of
 * how many projects/work items exist.
 *
 * `includeArchived` controls scope so the list's Active/Archived/All filter can
 * be served server-side; the default (`false`) preserves the prior behavior
 * for the Overview teaser.
 */
export async function getActiveProjectsForOrg(
  orgId: string,
  includeArchived = false,
) {
  "use cache";
  cacheLife("minutes");
  cacheTag(`org:${orgId}:projects`);

  const where = includeArchived ? { orgId } : { orgId, archived: false };

  const projects = await prisma.project.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      key: true,
      name: true,
      archived: true,
      updatedAt: true,
    },
  });

  if (projects.length === 0) return [] as ProjectRollup[];

  const projectIds = projects.map((p) => p.id);
  const now = new Date();

  const [totals, dones, nextDues, activeIntervals, leadMembers] =
    await Promise.all([
      // Total work items per project.
      prisma.workItem.groupBy({
        by: ["projectId"],
        where: { projectId: { in: projectIds } },
        _count: { _all: true },
      }),
      // Done work items per project (completedAt is the canonical done signal).
      prisma.workItem.groupBy({
        by: ["projectId"],
        where: { projectId: { in: projectIds }, completedAt: { not: null } },
        _count: { _all: true },
      }),
      // Earliest upcoming due date among incomplete items per project.
      prisma.workItem.groupBy({
        by: ["projectId"],
        where: {
          projectId: { in: projectIds },
          completedAt: null,
          dueDate: { gte: now },
        },
        _min: { dueDate: true },
      }),
      // Active interval name per project (at most one ACTIVE interval is expected).
      prisma.interval.findMany({
        where: { projectId: { in: projectIds }, status: "ACTIVE" },
        select: { projectId: true, name: true },
        orderBy: { startDate: "desc" },
      }),
      // Lead/owner per project: prefer LEAD, fall back to MANAGER. Note: User
      // is selected without OrgMember.permissions (BigInt) to keep the result
      // JSON-serializable across the server→client boundary.
      prisma.projectMember.findMany({
        where: {
          projectId: { in: projectIds },
          role: { in: ["LEAD", "MANAGER"] },
        },
        select: {
          projectId: true,
          role: true,
          orgMember: {
            select: {
              user: { select: { displayName: true, avatarUrl: true } },
            },
          },
        },
      }),
    ]);

  const totalByProject = new Map(
    totals.map((t) => [t.projectId, t._count._all]),
  );
  const doneByProject = new Map(dones.map((d) => [d.projectId, d._count._all]));
  const nextDueByProject = new Map(
    nextDues.map((n) => [n.projectId, n._min.dueDate]),
  );
  const intervalByProject = new Map<string, string>();
  for (const c of activeIntervals) {
    if (!intervalByProject.has(c.projectId)) intervalByProject.set(c.projectId, c.name);
  }
  // Resolve one lead per project. A LEAD always beats a MANAGER; among equals
  // the first row wins. We track the chosen role so a later LEAD can upgrade an
  // already-chosen MANAGER, but never the reverse.
  const leadByProject = new Map<
    string,
    { displayName: string; avatarUrl: string | null; role: string }
  >();
  for (const m of leadMembers) {
    const existing = leadByProject.get(m.projectId);
    if (existing && !(existing.role === "MANAGER" && m.role === "LEAD")) {
      continue;
    }
    leadByProject.set(m.projectId, {
      displayName: m.orgMember.user.displayName,
      avatarUrl: m.orgMember.user.avatarUrl,
      role: m.role,
    });
  }

  return projects.map<ProjectRollup>((p) => {
    const totalItems = totalByProject.get(p.id) ?? 0;
    const doneItems = doneByProject.get(p.id) ?? 0;
    const leadEntry = leadByProject.get(p.id);
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      archived: p.archived,
      updatedAt: p.updatedAt,
      totalItems,
      doneItems,
      percentComplete:
        totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0,
      lead: leadEntry
        ? { displayName: leadEntry.displayName, avatarUrl: leadEntry.avatarUrl }
        : null,
      activeIntervalName: intervalByProject.get(p.id) ?? null,
      nextDueDate: nextDueByProject.get(p.id) ?? null,
    };
  });
}

export async function getActiveProjectCountForOrg(orgId: string) {
  "use cache";
  cacheLife("minutes");
  cacheTag(`org:${orgId}:projects`);
  return prisma.project.count({ where: { orgId, archived: false } });
}

// ---------------------------------------------------------------------------
// Member lookups
// ---------------------------------------------------------------------------

/**
 * Total members of an org. Used in the dashboard header and KPI cards.
 */
export async function getOrgMemberCount(orgId: string) {
  "use cache";
  cacheLife("minutes");
  cacheTag(`org:${orgId}:members`);
  return prisma.orgMember.count({ where: { orgId } });
}

// ---------------------------------------------------------------------------
// Invalidation helpers — call after mutations that change the cached data.
// ---------------------------------------------------------------------------

export function revalidateOrg(ref: { id?: string; slug?: string }) {
  if (ref.id) revalidateTag(`org:${ref.id}`, { expire: 0 });
  if (ref.slug) revalidateTag(`org-slug:${ref.slug}`, { expire: 0 });
}

export function revalidateOrgProjects(orgId: string) {
  // Route-Handler invalidation: hard-expire so the very next /projects render
  // is a cache miss (read-your-own-writes). A finite profile like "minutes"
  // only marks the tag stale-while-revalidate, so the next visit still serves
  // the pre-create snapshot — see next/dist/.../revalidateTag.md. updateTag is
  // unavailable here (it throws E872 in Route Handlers).
  revalidateTag(`org:${orgId}:projects`, { expire: 0 });
}

export function revalidateOrgMembers(orgId: string) {
  revalidateTag(`org:${orgId}:members`, { expire: 0 });
}
