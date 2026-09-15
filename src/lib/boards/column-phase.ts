import { ColumnCategory } from "@prisma/client";

/**
 * Which phase a board column represents, for the actual-start / actual-end
 * auto-capture.
 *
 * This used to be guessed from the column KEY: started meant "not one of
 * backlog/todo/to-do", done meant "contains done/completed/closed". Both are
 * wrong for any column a team named itself. A board with a "Review" column
 * stamped an actual START on the way into review — which is how a user moving a
 * batch of tickets on the Sprint board had their Gantt bars all jump to today,
 * looking exactly like the planned start dates had been wiped.
 *
 * `BoardColumn.category` already carries this. It is a required enum with a
 * default, set when a column is created and editable in board settings, so it is
 * the source of truth and does not need to be inferred from prose.
 */
export type ColumnPhase = "not-started" | "started" | "done";

export function columnPhase(category: ColumnCategory): ColumnPhase {
  switch (category) {
    case ColumnCategory.IN_PROGRESS:
      return "started";
    case ColumnCategory.DONE:
      return "done";
    case ColumnCategory.TODO:
    case ColumnCategory.CANCELLED:
      // CANCELLED is deliberately "not-started": abandoning work is not
      // finishing it, and stamping an end date would report it as delivered.
      return "not-started";
  }
}

/** Does entering this column mean work has begun? DONE implies it too. */
export function isStartedPhase(category: ColumnCategory): boolean {
  const phase = columnPhase(category);
  return phase === "started" || phase === "done";
}

/** Does entering this column mean work has finished? */
export function isDonePhase(category: ColumnCategory): boolean {
  return columnPhase(category) === "done";
}
