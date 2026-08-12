import { isProgramIncrement } from "./pi-lifecycle";

/**
 * Where unfinished work should go by default when a sprint is completed.
 *
 * Returns an interval id, or `null` meaning the backlog.
 *
 * The completion dialog used to default to the backlog outright, so unless
 * someone noticed the dropdown, finishing a sprint quietly emptied its
 * remaining work out of every sprint. Teams running back-to-back sprints expect
 * what Jira does: the work rolls into the next one.
 *
 * Still only a DEFAULT — the dialog keeps the full choice, including the
 * backlog, because "this work should stop being scheduled" is a real answer.
 */

interface IntervalLike {
  id: string;
  number: number;
  status: "PLANNED" | "ACTIVE" | "COMPLETED";
  intervalKind: string;
}

export function defaultCarryForwardTarget(
  completing: { id: string; number: number },
  all: IntervalLike[]
): string | null {
  const next = all
    .filter(
      (i) =>
        i.id !== completing.id &&
        i.status === "PLANNED" &&
        // Strictly later. An earlier planned sprint is not "next", and pushing
        // work backwards hides it behind an iteration the team has moved past.
        i.number > completing.number &&
        // A PI contains sprints; it is not somewhere work is scheduled.
        !isProgramIncrement(i.intervalKind)
    )
    .sort((a, b) => a.number - b.number)[0];

  return next?.id ?? null;
}
