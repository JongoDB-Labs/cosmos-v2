/**
 * Sprint-review metrics — the retrospective figures shown when a sprint is being
 * completed, BEFORE it is finalized (COSMOS-139). Pure and derived on read: no
 * I/O, no persistence, so it can run identically on the server (the /complete
 * route) and in the client review step.
 *
 * "Done" is the item's status being in the DONE category (`isDoneStatus`), the
 * same rule the report recorded at completion and the ceremony boards use. It
 * used to be the key's spelling ("done"/"completed"/"closed"), which counted a
 * team-named done lane such as "Shipped" as unfinished work.
 */
import { isDoneStatus, type DoneStateColumn } from "@/lib/work-items/done-state";

export interface SprintReviewItem {
  storyPoints?: number | null;
  columnKey: string;
}

export interface SprintReviewInput {
  startDate: string | Date;
  endDate: string | Date;
  /** The moment the review is generated (sprint completion). Defaults to now. */
  reviewedAt?: string | Date;
  items: SprintReviewItem[];
  /** The project's statuses with their categories. */
  columns: readonly DoneStateColumn[];
}

export type PacingStatus = "ahead" | "on track" | "behind";

export interface SprintReview {
  totalItems: number;
  completedItems: number;
  incompleteItems: number;
  totalPoints: number;
  completedPoints: number;
  /** Whether story points or plain item counts were used as the unit of work. */
  basis: "points" | "items";
  /** Completed work ÷ committed work, as a 0–100 percentage. */
  efficiency: number;
  /** Completed work per elapsed day (in the chosen basis). */
  burnRate: number;
  /** Completed ÷ ideal-by-now. 1.0 = exactly on the ideal burndown line. */
  pacing: number;
  pacingStatus: PacingStatus;
  elapsedDays: number;
  plannedDays: number;
}

const DAY_MS = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeSprintReview(input: SprintReviewInput): SprintReview {
  const start = new Date(input.startDate).getTime();
  const end = new Date(input.endDate).getTime();
  const now = input.reviewedAt ? new Date(input.reviewedAt).getTime() : Date.now();

  const items = input.items;
  const totalItems = items.length;
  const doneItems = items.filter((i) => isDoneStatus(i.columnKey, input.columns));
  const completedItems = doneItems.length;
  const incompleteItems = totalItems - completedItems;

  const totalPoints = items.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
  const completedPoints = doneItems.reduce((s, i) => s + (i.storyPoints ?? 0), 0);

  // Estimated sprints measure in points; unestimated ones fall back to item counts.
  const basis: SprintReview["basis"] = totalPoints > 0 ? "points" : "items";
  const committed = basis === "points" ? totalPoints : totalItems;
  const completed = basis === "points" ? completedPoints : completedItems;

  // Planned duration and elapsed time, clamped to sane, non-negative day counts.
  const plannedDays = Math.max(1, Math.round((end - start) / DAY_MS));
  const elapsedDays = Math.min(plannedDays, Math.max(0, Math.round((now - start) / DAY_MS)));

  const efficiency = committed > 0 ? Math.round((completed / committed) * 100) : 0;
  const burnRate = round1(completed / Math.max(1, elapsedDays));

  // Ideal linear burndown: by the fraction of the sprint elapsed, an on-pace team
  // has completed that same fraction of committed work.
  const expected = committed * Math.min(1, elapsedDays / plannedDays);
  const pacing =
    expected > 0 ? round2(completed / expected) : completed > 0 ? 1 : 1;
  const pacingStatus: PacingStatus =
    committed === 0 ? "on track" : pacing >= 1.05 ? "ahead" : pacing <= 0.95 ? "behind" : "on track";

  return {
    totalItems,
    completedItems,
    incompleteItems,
    totalPoints,
    completedPoints,
    basis,
    efficiency,
    burnRate,
    pacing,
    pacingStatus,
    elapsedDays,
    plannedDays,
  };
}
