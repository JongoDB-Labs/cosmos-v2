import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { measureKeyResult, rollUpObjective, shownKeyResult } from "./progress";

/**
 * Live objective progress, for every server path that shows it.
 *
 * `Objective.progress` is a stored copy, and nothing should read it. It was
 * recomputed only when a key result was edited or checked in, so it went stale
 * whenever a linked ticket finished, a key result was added or deleted, or a
 * ticket was linked or unlinked: a key result whose three linked tickets were
 * all done still counted as 0 there while the OKR board said 100. Keeping it
 * current would mean a write on every path that finishes or reopens a work
 * item, a list that keeps growing. So every reader computes from the same rule
 * as the board instead (`measureKeyResult` and `rollUpObjective` in
 * ./progress), and so does every response that hands out an existing
 * objective. The copy is still written where it always was, for anything
 * outside the app that reads the table, but the app never reads it back.
 */

const DONE = { select: { workItem: { select: { completedAt: true } } } } as const;

/** What an objective's live progress reads. Spread it into a `select`. */
export const LIVE_PROGRESS_SELECT = {
  keyResults: {
    select: {
      startValue: true, currentValue: true, targetValue: true, lowerIsBetter: true, status: true, links: DONE,
    },
  },
  links: DONE,
} as const satisfies Prisma.ObjectiveSelect;

type LiveProgressRow = Prisma.ObjectiveGetPayload<{ select: typeof LIVE_PROGRESS_SELECT }>;

/** One objective's live progress, 0-100. */
export function liveProgressOf(o: LiveProgressRow): number {
  const keyResults = o.keyResults.map((kr) => measureKeyResult(kr, kr.links.map((l) => l.workItem)));
  return rollUpObjective(keyResults, o.links.map((l) => l.workItem)).progress;
}

/** Live progress of every objective `where` matches, by id. */
export async function liveObjectiveProgress(
  where: Prisma.ObjectiveWhereInput,
): Promise<Map<string, number>> {
  const rows = await prisma.objective.findMany({
    where,
    select: { id: true, ...LIVE_PROGRESS_SELECT },
  });
  return new Map(rows.map((o) => [o.id, liveProgressOf(o)]));
}

/**
 * One objective as the API hands it out: its row, with live progress, and its
 * key results with the numbers and status they show. Null when `where` matches
 * nothing.
 */
export async function liveObjective(where: Prisma.ObjectiveWhereInput) {
  const objective = await prisma.objective.findFirst({
    where,
    include: { keyResults: { orderBy: { sortOrder: "asc" }, include: { links: DONE } }, links: DONE },
  });
  if (!objective) return null;
  const { keyResults, links, ...row } = objective;
  const measured = keyResults.map(({ links: krLinks, ...kr }) => ({
    kr,
    m: measureKeyResult(kr, krLinks.map((l) => l.workItem)),
  }));
  return {
    ...row,
    progress: rollUpObjective(measured.map(({ m }) => m), links.map((l) => l.workItem)).progress,
    keyResults: measured.map(({ kr, m }) => shownKeyResult(kr, m)),
  };
}

/** One key result as the API hands it out: the numbers and status it shows. */
export async function liveKeyResult(id: string) {
  const kr = await prisma.keyResult.findUnique({ where: { id }, include: { links: DONE } });
  if (!kr) return null;
  const { links, ...row } = kr;
  return shownKeyResult(row, measureKeyResult(row, links.map((l) => l.workItem)));
}

/** Write an objective's stored progress from the live rule. */
export async function recomputeObjectiveProgress(objectiveId: string): Promise<void> {
  const progress = (await liveObjectiveProgress({ id: objectiveId })).get(objectiveId);
  if (progress === undefined) return;
  await prisma.objective.update({ where: { id: objectiveId }, data: { progress } });
}
