import type { IntervalKind, SprintStatus } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { ProblemError } from "@/lib/openapi/problem";
import {
  activationBlocker,
  isProgramIncrement,
  nestingRefusal,
  programIncrementBlockers,
  userMaySetStatus,
} from "./pi-lifecycle";

/**
 * Change an interval's status or parent under the Program Increment rules: the
 * checks, then the caller's own write, then what the change starts.
 *
 * Every writer of those two fields goes through here: `PUT /intervals/{id}`
 * and `POST /intervals/{id}/complete`, and Cosmo's `update_interval` and
 * `complete_interval`. The agent used to keep its own copy, written
 * before Program Increments existed. It counted a running PI as a competitor,
 * so no sprint inside one could be started through the assistant, and it
 * applied none of the rest: it let a PI be started by hand, completed a PI with
 * sprints still open, and left the PI around a sprint it started sitting
 * PLANNED. The route had all four. One function, so the next rule reaches both.
 * Both complete doors had only "it must be ACTIVE", so a running PI completed
 * with its sprints still open on either side.
 *
 * The rules themselves are the pure functions in `pi-lifecycle.ts`, which the
 * client imports too; this is the server half that reads the rows they judge.
 *
 * `write` is the caller's update: the two writers store dates differently and
 * answer with different projections, and neither is a rule. It runs only after
 * every check has passed, and its result is returned as is.
 *
 * Refuses with a `ProblemError` carrying the route's status and words, so the
 * route's `handleApiError` answers exactly as before and a tool folds it with
 * `serviceRefusal`.
 */
export async function writeIntervalChange<T>(
  existing: { id: string; projectId: string; intervalKind: IntervalKind; parentId: string | null },
  change: { status?: SprintStatus; parentId?: string | null },
  write: () => Promise<T>,
): Promise<T> {
  // A re-parent: the target must be a PROGRAM_INCREMENT in this project, an
  // interval can't be its own parent, and a PI is always top-level.
  if (change.parentId !== undefined && change.parentId !== null) {
    if (change.parentId === existing.id) {
      throw new ProblemError(400, "invalid_request", "An interval can't be its own Program Increment");
    }
    const parent = await prisma.interval.findFirst({
      where: { id: change.parentId, projectId: existing.projectId },
      select: { intervalKind: true },
    });
    const refusal = nestingRefusal(existing.intervalKind, parent);
    if (refusal) throw new ProblemError(400, "invalid_request", refusal);
  }

  // A Program Increment is a container: it spans its sprints rather than
  // competing with them, so it is never started by hand.
  if (change.status !== undefined && !userMaySetStatus(existing.intervalKind, change.status)) {
    throw new ProblemError(409, "conflict", "A Program Increment starts when its first sprint starts — it is not started directly.");
  }

  if (change.status === "ACTIVE") {
    const others = await prisma.interval.findMany({
      where: { projectId: existing.projectId },
      select: { id: true, name: true, intervalKind: true, status: true },
    });
    // Excludes Program Increments. Counting the parent PI as a competitor is
    // what made a sprint unable to start until its own PI had finished — which
    // could never happen, since a PI finishes when its sprints do.
    const blocker = activationBlocker({ id: existing.id }, others);
    if (blocker) throw new ProblemError(409, "conflict", `${blocker.name} is still active — complete it first.`);
  }

  // A PI is done only once everything inside it is. Named, so the refusal
  // tells the user what to finish.
  if (change.status === "COMPLETED" && isProgramIncrement(existing.intervalKind)) {
    const children = await prisma.interval.findMany({
      where: { parentId: existing.id },
      select: { id: true, name: true, intervalKind: true, status: true },
    });
    const open = programIncrementBlockers(children);
    if (open.length > 0) {
      throw new ProblemError(
        409,
        "conflict",
        `This Program Increment still has unfinished iterations: ${open.map((i) => i.name).join(", ")}.`,
      );
    }
  }

  const result = await write();

  // Starting a sprint starts the increment that contains it. The PI has no
  // start control of its own, so without this it would sit PLANNED while its
  // sprints ran — and its own completion gate would read as already satisfied.
  // The PI the sprint is in AFTER this change, so a change that also moves it
  // starts the PI it lands in, not the one it left.
  const parentAfter = change.parentId !== undefined ? change.parentId : existing.parentId;
  if (change.status === "ACTIVE" && parentAfter) {
    await prisma.interval.updateMany({
      where: { id: parentAfter, intervalKind: "PROGRAM_INCREMENT", status: "PLANNED" },
      data: { status: "ACTIVE" },
    });
  }

  return result;
}
