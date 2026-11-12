import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { measureKeyResult, rollUpObjective } from "./progress";

/**
 * Live objective progress, for every server path that shows or stores it.
 *
 * `Objective.progress` is a stored copy. It used to be recomputed only when a
 * key result was edited or checked in, from the stored numbers alone, so it
 * ignored linked work items entirely: a key result whose three linked tickets
 * were all done still counted as 0 there while the OKR board said 100. A
 * dashboard widget and a goal's auto progress read that copy. Every reader now
 * computes from the same rule as the board (`measureKeyResult` and
 * `rollUpObjective` in ./progress), and the stored copy is written by that rule
 * too.
 */

const DONE = { select: { workItem: { select: { completedAt: true } } } } as const;

/** What an objective's live progress reads. Spread it into a `select`. */
export const LIVE_PROGRESS_SELECT = {
  keyResults: {
    select: { startValue: true, currentValue: true, targetValue: true, lowerIsBetter: true, links: DONE },
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

/** Write an objective's stored progress from the live rule. */
export async function recomputeObjectiveProgress(objectiveId: string): Promise<void> {
  const progress = (await liveObjectiveProgress({ id: objectiveId })).get(objectiveId);
  if (progress === undefined) return;
  await prisma.objective.update({ where: { id: objectiveId }, data: { progress } });
}
