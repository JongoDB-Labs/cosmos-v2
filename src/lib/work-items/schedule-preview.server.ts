/**
 * The dry run behind the Gantt's confirm step: what a reschedule WOULD do,
 * computed without writing anything.
 *
 * Three things core can answer on its own:
 *  - the dates every changed item moves to;
 *  - what the cascade (COSMOS-154) would move with them: parents widened to
 *    their children, successors shifted by the slip. Planned by the SAME pure
 *    planner the save runs, fed the same skip lists the Gantt's save sends, so
 *    the preview and the save cannot disagree;
 *  - for each person assigned to anything that moves, the most items they have
 *    running on one day in the affected window, and the story points scheduled
 *    in it, before and after. THIS project's items only: counting their work in
 *    other projects would tell the caller about projects they may not be able
 *    to see.
 * Fees, rates and hours are not core's to know: a plugin adds them through
 * `PluginServerHooks.scheduleImpact` (see `collectPluginImpact`).
 *
 * Dates come back as ISO strings and are formatted on the client, in the
 * viewer's own days, the same days the chart draws.
 */
import type { PrismaClient } from "@prisma/client";
import { planScheduleCascade, type CascadeItem } from "@/lib/work-items/schedule-cascade";
import type { ScheduleChange } from "@/lib/work-items/schedule-impact";

const DAY = 86_400_000;

export interface PreviewItemInput {
  id: string;
  startDate: string | null;
  dueDate: string | null;
}

export interface AllocationRow {
  userId: string;
  name: string;
  /** Hours a week from the member's profile, when one is set. */
  weeklyCapacityHours: number | null;
  /** Most of their items running on any one day in the affected window. */
  peakBefore: number;
  peakAfter: number;
  /** Story points of their items overlapping the affected window. */
  pointsBefore: number;
  pointsAfter: number;
}

export interface CorePreview {
  changes: ScheduleChange[];
  cascaded: (ScheduleChange & { reason: "successor-shift" | "parent-envelope" })[];
  allocation: AllocationRow[];
}

type Row = CascadeItem & { storyPoints: number | null; people: string[] };

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const dayIndex = (d: Date) => Math.floor(d.getTime() / DAY);

/** The planned days an item occupies: [start, due], or its one known day. */
function span(it: { startDate: Date | null; dueDate: Date | null }): [number, number] | null {
  const s = it.startDate ?? it.dueDate;
  const e = it.dueDate ?? it.startDate;
  if (!s || !e) return null;
  const a = dayIndex(s);
  const b = dayIndex(e);
  return a <= b ? [a, b] : [b, a];
}

function load(items: Row[], userId: string, window: [number, number]) {
  const counts = new Map<number, number>();
  let points = 0;
  for (const it of items) {
    if (!it.people.includes(userId)) continue;
    const sp = span(it);
    if (!sp || sp[1] < window[0] || sp[0] > window[1]) continue;
    points += it.storyPoints ?? 0;
    for (let d = Math.max(sp[0], window[0]); d <= Math.min(sp[1], window[1]); d++) {
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  return { peak: Math.max(0, ...counts.values()), points };
}

/**
 * Plan the impact of moving `input` (items in `projectId`). The caller has
 * already checked the caller may read the project and update each item; ids
 * that are not live items of this project come back in `missing`.
 */
export async function previewSchedule(
  db: PrismaClient,
  args: { orgId: string; projectId: string; input: PreviewItemInput[] },
): Promise<CorePreview & { missing: string[] }> {
  const { orgId, projectId, input } = args;

  // Exactly what the save's cascade loads (schedule-cascade-io): live items of
  // this project and the links between them.
  const rows = await db.workItem.findMany({
    where: { orgId, projectId, archivedAt: null },
    select: {
      id: true,
      parentId: true,
      startDate: true,
      dueDate: true,
      storyPoints: true,
      assigneeId: true,
      assignees: { select: { userId: true } },
    },
  });
  const links = await db.workItemLink.findMany({
    where: { orgId, sourceItem: { projectId }, targetItem: { projectId } },
    select: { type: true, sourceItemId: true, targetItemId: true },
  });

  const original = new Map<string, Row>(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        parentId: r.parentId,
        startDate: r.startDate,
        dueDate: r.dueDate,
        storyPoints: r.storyPoints,
        people: [...new Set([...(r.assigneeId ? [r.assigneeId] : []), ...r.assignees.map((a) => a.userId)])],
      },
    ]),
  );
  const missing = input.filter((c) => !original.has(c.id)).map((c) => c.id);
  if (missing.length > 0) return { changes: [], cascaded: [], allocation: [], missing };

  // The world after the change, built the way the save builds it: every item
  // the action sets by hand first, then each one's cascade in turn, each told
  // what is already settled (the Gantt's commitSchedule sends the same lists).
  const working = new Map<string, Row>([...original].map(([id, r]) => [id, { ...r }]));
  for (const c of input) {
    const r = working.get(c.id)!;
    r.startDate = c.startDate ? new Date(c.startDate) : null;
    r.dueDate = c.dueDate ? new Date(c.dueDate) : null;
  }
  const settled = new Set(input.map((c) => c.id));
  const cascaded: CorePreview["cascaded"] = [];
  for (const c of input) {
    const before = original.get(c.id)!.dueDate;
    const after = working.get(c.id)!.dueDate;
    const dueShiftMs = before && after ? after.getTime() - before.getTime() : 0;
    const updates = planScheduleCascade([...working.values()], links, {
      id: c.id,
      dueShiftMs,
      skipIds: [...settled].filter((id) => id !== c.id),
    });
    for (const u of updates) {
      if (settled.has(u.id)) continue;
      settled.add(u.id);
      const r = working.get(u.id)!;
      const o = original.get(u.id)!;
      r.startDate = u.startDate;
      r.dueDate = u.dueDate;
      cascaded.push({
        itemId: u.id,
        reason: u.reason,
        before: { startDate: iso(o.startDate), dueDate: iso(o.dueDate) },
        after: { startDate: iso(u.startDate), dueDate: iso(u.dueDate) },
      });
    }
  }

  const changes: ScheduleChange[] = input.map((c) => {
    const o = original.get(c.id)!;
    return {
      itemId: c.id,
      before: { startDate: iso(o.startDate), dueDate: iso(o.dueDate) },
      after: { startDate: c.startDate, dueDate: c.dueDate },
    };
  });

  // Who is affected: anyone assigned to something that moves. The window is
  // every day any moved item occupies, before or after.
  const movedIds = [...settled];
  const people = new Set(movedIds.flatMap((id) => original.get(id)!.people));
  const days = movedIds.flatMap((id) => [span(original.get(id)!), span(working.get(id)!)]).filter(Boolean) as [
    number,
    number,
  ][];
  const allocation: AllocationRow[] = [];
  if (people.size > 0 && days.length > 0) {
    const window: [number, number] = [Math.min(...days.map((d) => d[0])), Math.max(...days.map((d) => d[1]))];
    const users = await db.user.findMany({
      where: { id: { in: [...people] } },
      select: { id: true, displayName: true },
    });
    const profiles = await db.orgMemberProfile.findMany({
      where: { orgId, userId: { in: [...people] } },
      select: { userId: true, weeklyCapacity: true },
    });
    const before = [...original.values()];
    const after = [...working.values()];
    for (const u of users) {
      const b = load(before, u.id, window);
      const a = load(after, u.id, window);
      if (a.peak === b.peak && a.points === b.points) continue;
      allocation.push({
        userId: u.id,
        name: u.displayName,
        weeklyCapacityHours: profiles.find((p) => p.userId === u.id)?.weeklyCapacity ?? null,
        peakBefore: b.peak,
        peakAfter: a.peak,
        pointsBefore: b.points,
        pointsAfter: a.points,
      });
    }
    allocation.sort((x, y) => y.peakAfter - y.peakBefore - (x.peakAfter - x.peakBefore) || x.name.localeCompare(y.name));
  }

  return { changes, cascaded, allocation, missing: [] };
}
