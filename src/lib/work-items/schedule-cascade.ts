/**
 * Interdependent rescheduling (FR COSMOS-154).
 *
 * Moving one bar on the Gantt has never moved anything else, so a task that
 * slips leaves its epic claiming the old finish date and every item waiting on
 * it still sitting in the past. This module answers the one question that fixes
 * both: given the item that was just saved, WHICH other items must move, and to
 * where?
 *
 * Two propagation rules, and they feed each other:
 *
 *  - **Downstream (the linked-items graph).** A successor of an item whose
 *    FINISH slipped later shifts by the same delta — start and due together, so
 *    its duration is preserved — and its own successors after it. Direction
 *    comes from `directedDependencyEdge`, the SAME normalization the create-time
 *    cycle guard and the dependency map use, so "downstream" means exactly what
 *    the arrows already drawn on the chart mean.
 *  - **Upstream (the parent hierarchy).** A parent EXPANDS to the envelope of
 *    its children: it starts no later than its earliest child and finishes no
 *    earlier than its latest. Expansion only — a parent deliberately scheduled
 *    wider than its children is a plan, not an error, so nothing here shrinks
 *    one. When that expansion pushes the parent's own finish later, the parent's
 *    successors shift too, which is why the two rules run off one worklist
 *    rather than as two passes.
 *
 * Only a SLIP propagates downstream (`dueShiftMs > 0`). Pulling an item in is
 * not the scenario the constraint protects against, and dragging every dependent
 * earlier would silently consume slack the user built in on purpose. Parent
 * envelopes are recomputed in both directions, because an envelope is a fact
 * about the children rather than a judgement about the plan.
 *
 * Pure: dates in, dates out, no I/O. `schedule-cascade-io.ts` loads the rows and
 * writes the result back.
 */

import { directedDependencyEdge } from "@/lib/work-items/dependency-graph";
import type { LinkType } from "@prisma/client";

/** The minimal item shape the planner reads. */
export interface CascadeItem {
  id: string;
  parentId: string | null;
  startDate: Date | null;
  dueDate: Date | null;
}

/** The minimal link shape the planner reads (a `WorkItemLink` row). */
export interface CascadeLink {
  type: LinkType | string;
  sourceItemId: string;
  targetItemId: string;
}

export interface CascadeUpdate {
  id: string;
  startDate: Date | null;
  dueDate: Date | null;
  /** Why this item moved — surfaced in the activity trail and the toast. */
  reason: "successor-shift" | "parent-envelope";
}

const ms = (d: Date | null): number | null => (d ? d.getTime() : null);

function pushInto(map: Map<string, string[]>, key: string, value: string): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/**
 * Plan the cascade for a save on `originId`.
 *
 * `items` must already carry the origin's NEW dates — the planner reads the
 * post-save world and never rewrites the origin itself, so what the user
 * explicitly asked for always wins over anything derived from it.
 *
 * `dueShiftMs` is how far the origin's finish moved LATER (0 or negative when it
 * did not slip). Returns one update per affected item; an empty array means
 * nothing else has to move.
 */
export function planScheduleCascade(
  items: CascadeItem[],
  links: CascadeLink[],
  origin: { id: string; dueShiftMs: number },
): CascadeUpdate[] {
  const byId = new Map<string, CascadeItem>(items.map((i) => [i.id, { ...i }]));
  if (!byId.has(origin.id)) return [];

  // from → [to]: `to` depends on `from`, so `to` is downstream of it.
  const successors = new Map<string, string[]>();
  for (const l of links) {
    const edge = directedDependencyEdge(l.type, l.sourceItemId, l.targetItemId);
    if (edge && byId.has(edge.from) && byId.has(edge.to)) pushInto(successors, edge.from, edge.to);
  }
  const childrenOf = new Map<string, string[]>();
  for (const it of byId.values()) {
    if (it.parentId && byId.has(it.parentId)) pushInto(childrenOf, it.parentId, it.id);
  }

  const updates = new Map<string, CascadeUpdate>();
  // The origin is seeded as already-shifted: it is the thing the user saved, so
  // no rule may move it again — and seeding it is also what stops a dependency
  // cycle (legacy links can contain one) from walking forever.
  const shifted = new Set<string>([origin.id]);
  const queue: Array<{ id: string; dueShiftMs: number }> = [
    { id: origin.id, dueShiftMs: origin.dueShiftMs },
  ];
  // Belt-and-braces bound: a parent may legitimately be re-examined as more of
  // its children move, so the visited set alone does not cap the worklist.
  let steps = 0;
  const maxSteps = byId.size * 4 + 64;

  while (queue.length > 0 && steps++ < maxSteps) {
    const { id, dueShiftMs } = queue.shift()!;
    const node = byId.get(id);
    if (!node) continue;

    // ── Downstream: successors of a SLIPPED item shift by the same delta.
    if (dueShiftMs > 0) {
      for (const toId of successors.get(id) ?? []) {
        if (shifted.has(toId)) continue;
        const target = byId.get(toId);
        if (!target) continue;
        // An unscheduled item has nothing to shift; moving it would be inventing
        // dates rather than preserving a plan.
        if (!target.startDate && !target.dueDate) continue;
        const startDate = target.startDate
          ? new Date(target.startDate.getTime() + dueShiftMs)
          : null;
        const dueDate = target.dueDate ? new Date(target.dueDate.getTime() + dueShiftMs) : null;
        shifted.add(toId);
        byId.set(toId, { ...target, startDate, dueDate });
        updates.set(toId, { id: toId, startDate, dueDate, reason: "successor-shift" });
        queue.push({ id: toId, dueShiftMs: dueDate ? dueShiftMs : 0 });
      }
    }

    // ── Upstream: the parent expands to cover its children.
    const parentId = node.parentId;
    if (!parentId) continue;
    const parent = byId.get(parentId);
    // Never re-derive the origin or an item the user's own save is anchored on.
    if (!parent || parentId === origin.id) continue;

    let startDate = parent.startDate;
    let dueDate = parent.dueDate;
    for (const kidId of childrenOf.get(parentId) ?? []) {
      const kid = byId.get(kidId);
      if (!kid) continue;
      if (kid.startDate && (!startDate || kid.startDate < startDate)) startDate = kid.startDate;
      if (kid.dueDate && (!dueDate || kid.dueDate > dueDate)) dueDate = kid.dueDate;
    }
    if (ms(startDate) === ms(parent.startDate) && ms(dueDate) === ms(parent.dueDate)) continue;

    const parentSlip =
      dueDate && parent.dueDate ? dueDate.getTime() - parent.dueDate.getTime() : 0;
    byId.set(parentId, { ...parent, startDate, dueDate });
    updates.set(parentId, { id: parentId, startDate, dueDate, reason: "parent-envelope" });
    queue.push({ id: parentId, dueShiftMs: parentSlip });
  }

  return [...updates.values()];
}

/** A dependency edge whose ends are scheduled in the wrong order. */
export interface ScheduleViolation {
  /** The item that must finish first. */
  fromId: string;
  /** The item that depends on it. */
  toId: string;
  /** How many whole days `fromId`'s finish overruns `toId`'s start (≥ 1). */
  overlapDays: number;
}

const DAY_MS = 86_400_000;

/**
 * Which dependency edges the current schedule contradicts: a predecessor must
 * end on or before its successor starts, so `from.dueDate > to.startDate` is a
 * violation. Drives the Gantt's conflict badge and the red arrows — the same
 * normalized direction the cascade propagates along, so the chart cannot flag an
 * edge the planner would not have moved.
 */
export function scheduleViolations(
  items: Array<{ id: string; startDate: Date | null; dueDate: Date | null }>,
  links: CascadeLink[],
): ScheduleViolation[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: ScheduleViolation[] = [];
  const seen = new Set<string>();

  for (const l of links) {
    const edge = directedDependencyEdge(l.type, l.sourceItemId, l.targetItemId);
    if (!edge) continue;
    const key = `${edge.from}>${edge.to}`;
    if (seen.has(key)) continue;
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from?.dueDate || !to?.startDate) continue;
    const overlapMs = from.dueDate.getTime() - to.startDate.getTime();
    if (overlapMs <= 0) continue;
    seen.add(key);
    out.push({
      fromId: edge.from,
      toId: edge.to,
      overlapDays: Math.max(1, Math.round(overlapMs / DAY_MS)),
    });
  }

  return out;
}
