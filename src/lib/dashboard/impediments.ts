/**
 * Blocked work, and increment objectives.
 *
 * Both read endpoints the product already serves — `work-item-links` and
 * `objectives` — so neither needs new plumbing. What they need is the same thing
 * every panel on this board needs: a decision about what NOT to claim.
 */

// ---------------------------------------------------------------------------
// Impediments
// ---------------------------------------------------------------------------

export interface WorkItemLinkLike {
  id: string;
  type: string;
  sourceItemId: string;
  targetItemId: string;
  sourceTicketNumber: number;
  sourceTitle: string;
  targetTicketNumber: number;
  targetTitle: string;
  createdAt: string | Date;
}

export interface BlockedItem {
  workItemId: string;
  ticketNumber: number;
  title: string;
  /** The item standing in the way. */
  blockedByTicketNumber: number;
  blockedByTitle: string;
  /**
   * Days since the block was RECORDED. Not since work stopped — nobody records
   * that — so the panel says which it is rather than implying the stronger one.
   */
  daysBlocked: number;
}

export interface ImpedimentsResult {
  blocked: BlockedItem[];
  /**
   * Blocking links pointing at work that is already finished. They are not
   * impediments, but they ARE clutter that makes the real ones harder to see,
   * and a reader who cannot see the count assumes the board is showing them all.
   */
  staleLinks: number;
}

/**
 * Which items are currently blocked, longest first.
 *
 * BOTH link directions count. `A BLOCKED_BY B` and `B BLOCKS A` express exactly
 * the same fact, and which one is stored depends on which end the user happened
 * to be looking at when they made the link. Reading only one direction would
 * silently miss half the impediments on the board — the kind of half-right query
 * that looks like a working feature.
 *
 * A finished item is NOT an impediment however stale its link. Work that shipped
 * is not stuck, and counting it would inflate the number that is supposed to
 * prompt action.
 */
export function impediments(
  links: readonly WorkItemLinkLike[],
  doneItemIds: ReadonlySet<string>,
  now: Date,
): ImpedimentsResult {
  const blocked: BlockedItem[] = [];
  let staleLinks = 0;

  for (const link of links) {
    let victimId: string;
    let victimTicket: number;
    let victimTitle: string;
    let blockerTicket: number;
    let blockerTitle: string;

    if (link.type === "BLOCKED_BY") {
      // source is blocked by target
      victimId = link.sourceItemId;
      victimTicket = link.sourceTicketNumber;
      victimTitle = link.sourceTitle;
      blockerTicket = link.targetTicketNumber;
      blockerTitle = link.targetTitle;
    } else if (link.type === "BLOCKS") {
      // source blocks target
      victimId = link.targetItemId;
      victimTicket = link.targetTicketNumber;
      victimTitle = link.targetTitle;
      blockerTicket = link.sourceTicketNumber;
      blockerTitle = link.sourceTitle;
    } else {
      continue;
    }

    if (doneItemIds.has(victimId)) {
      staleLinks += 1;
      continue;
    }

    const at = link.createdAt instanceof Date ? link.createdAt : new Date(link.createdAt);
    const days = Number.isNaN(at.getTime())
      ? 0
      : Math.max(0, (now.getTime() - at.getTime()) / 86_400_000);

    blocked.push({
      workItemId: victimId,
      ticketNumber: victimTicket,
      title: victimTitle,
      blockedByTicketNumber: blockerTicket,
      blockedByTitle: blockerTitle,
      daysBlocked: days,
    });
  }

  // Longest first: the oldest block is the one that has cost the most and is
  // least likely to be resolving itself.
  blocked.sort((a, b) => b.daysBlocked - a.daysBlocked);
  return { blocked, staleLinks };
}

// ---------------------------------------------------------------------------
// Increment objectives
// ---------------------------------------------------------------------------

export interface ObjectiveLike {
  id: string;
  title: string;
  status: string;
  progress: number;
  intervalId: string | null;
  /** SAFe: committed objectives are the promise; stretch ones explicitly are not. */
  committed?: boolean;
  health?: string | null;
}

export interface ObjectiveRollup {
  committed: ObjectiveLike[];
  stretch: ObjectiveLike[];
  /**
   * Mean progress across COMMITTED objectives only. Null when there are none —
   * an increment with nothing committed has no completion to report, and 0%
   * would read as total failure rather than as an empty plan.
   */
  committedProgress: number | null;
  /** Committed objectives at 100%. */
  met: number;
}

/**
 * Objectives for one increment, split by commitment.
 *
 * THE SPLIT IS THE POINT. In SAFe, stretch objectives are deliberately excluded
 * from the commitment — they exist so a team can surface upside without being
 * judged on it. Averaging them into "increment progress" punishes exactly the
 * behaviour the practice is trying to encourage, and it is the single most
 * common way a PI report gets read as worse than the increment actually went.
 */
export function objectiveRollup(
  objectives: readonly ObjectiveLike[],
  intervalId: string,
): ObjectiveRollup {
  const mine = objectives.filter((o) => o.intervalId === intervalId);
  // `committed` defaults TRUE, matching the API's own default: an objective
  // recorded before the field existed was a commitment.
  const committed = mine.filter((o) => o.committed !== false);
  const stretch = mine.filter((o) => o.committed === false);

  return {
    committed,
    stretch,
    committedProgress:
      committed.length > 0
        ? committed.reduce((s, o) => s + o.progress, 0) / committed.length
        : null,
    met: committed.filter((o) => o.progress >= 100).length,
  };
}
