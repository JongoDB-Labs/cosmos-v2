import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { getReadableProjectIds } from "@/lib/work-items/query/scope";
import { buildWorkItemWhere } from "@/lib/work-items/query/build-where";
import { isWorkItemResolved } from "@/lib/work-items/done-state";
import { DAY_MS } from "./time";
import {
  AGILE_INTERVAL_KINDS,
  DUE_CAP,
  type AgileIntervalKind,
  type AgilePayload,
} from "./overlays";

/**
 * The Agile overlay's rows for one calendar window: Program Increments,
 * sprints and releases, and the work items that fall due.
 *
 * Each kind is read under the rule of the API that already serves it, so the
 * calendar can never show someone a sprint or a ticket that its own page would
 * refuse them:
 *
 * - Intervals: SPRINT_READ, per project, as `GET .../projects/{id}/intervals`
 *   asks it.
 * - Work items: ITEM_READ, per project, through the same where-builder as the
 *   org-wide work-item search (archived items stay out, as they do there).
 *
 * `getReadableProjectIds` is the one place both rules are resolved. It applies
 * the action's bit, team-scoped projects, the org's allow/deny rules, and an
 * API key's project limit, before any role shortcut.
 *
 * `projectId`, when given, NARROWS that set: naming a project the caller cannot
 * read returns nothing for it rather than widening anything.
 */
export async function loadAgileOverlay(
  ctx: AuthContext,
  window: { from: Date; to: Date; projectId?: string },
): Promise<AgilePayload> {
  const narrow = (ids: string[]) =>
    window.projectId ? ids.filter((id) => id === window.projectId) : ids;

  const [sprintProjects, itemProjects] = await Promise.all([
    getReadableProjectIds(ctx, "SPRINT_READ").then(narrow),
    getReadableProjectIds(ctx, "ITEM_READ").then(narrow),
  ]);

  const [intervals, due] = await Promise.all([
    sprintProjects.length ? readIntervals(ctx.orgId, sprintProjects, window) : Promise.resolve([]),
    itemProjects.length ? readDue(ctx.orgId, itemProjects, window) : Promise.resolve({ rows: [], capped: false }),
  ]);
  return { intervals, due: due.rows, dueCapped: due.capped };
}

async function readIntervals(
  orgId: string,
  projectIds: string[],
  { from, to }: { from: Date; to: Date },
): Promise<AgilePayload["intervals"]> {
  // An interval's end date is its LAST day, so it covers [start, end + 1 day).
  // Overlap with the half-open window [from, to) is therefore
  // `start < to AND end + 1 day > from`, i.e. `end > from - 1 day`.
  const rows = await prisma.interval.findMany({
    where: {
      orgId,
      projectId: { in: projectIds },
      intervalKind: { in: Object.keys(AGILE_INTERVAL_KINDS) as AgileIntervalKind[] },
      startDate: { lt: to },
      endDate: { gt: new Date(from.getTime() - DAY_MS) },
    },
    select: {
      id: true,
      name: true,
      intervalKind: true,
      startDate: true,
      endDate: true,
      project: { select: { key: true, name: true } },
    },
    orderBy: [{ startDate: "asc" }, { number: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.intervalKind as AgileIntervalKind,
    startDate: r.startDate.toISOString(),
    endDate: r.endDate.toISOString(),
    projectKey: r.project.key,
    projectName: r.project.name,
  }));
}

async function readDue(
  orgId: string,
  projectIds: string[],
  { from, to }: { from: Date; to: Date },
): Promise<{ rows: AgilePayload["due"]; capped: boolean }> {
  const where = buildWorkItemWhere({
    orgId,
    allowedProjectIds: projectIds,
    // `to` is exclusive here and inclusive in the builder's range, so stop one
    // millisecond short of it.
    filter: { dueDate: { from: from.toISOString(), to: new Date(to.getTime() - 1).toISOString() } },
  });
  const rows = await prisma.workItem.findMany({
    where,
    select: {
      id: true,
      ticketNumber: true,
      title: true,
      dueDate: true,
      columnKey: true,
      completedAt: true,
      status: { select: { key: true, category: true } },
      project: { select: { key: true } },
    },
    orderBy: [{ dueDate: "asc" }, { ticketNumber: "asc" }],
    take: DUE_CAP + 1,
  });
  const capped = rows.length > DUE_CAP;
  return {
    capped,
    rows: rows.slice(0, DUE_CAP).map((r) => ({
      id: r.id,
      key: `${r.project.key}-${r.ticketNumber}`,
      title: r.title,
      dueDate: r.dueDate!.toISOString(),
      resolved: isWorkItemResolved(r, [r.status]),
    })),
  };
}
