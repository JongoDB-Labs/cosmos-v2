/**
 * Should moving a child offer to bring its parent along?
 *
 * Nothing blocks a child from moving ahead of its parent — there is no such rule
 * in the board or the API, and there should not be: a parent is done when its
 * children are, not before. But a child landing in In Progress while its parent
 * still sits in Backlog leaves the parent lying about the state of the work, and
 * the only way to fix it today is to remember to go and move it.
 *
 * So this is a PROMPT, never an enforcement. It fires when the child has moved
 * FORWARD past its parent — never backward, and never onto a done parent, where
 * dragging the parent back would be actively wrong.
 */

export type Phase = "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";

/** Workflow order. CANCELLED sits outside it — see `shouldOfferParentCascade`. */
const RANK: Record<Phase, number> = {
  TODO: 0,
  IN_PROGRESS: 1,
  DONE: 2,
  CANCELLED: -1,
};

export interface CascadeInput {
  /** The category of the column the child was dropped into. */
  childCategory: Phase;
  /** The category of the column the parent currently sits in. */
  parentCategory: Phase;
}

export function shouldOfferParentCascade({
  childCategory,
  parentCategory,
}: CascadeInput): boolean {
  // CANCELLED is not a workflow position, so "ahead" is meaningless either way.
  // Cancelling a child says nothing about the parent, and a cancelled parent
  // should not be resurrected by moving one of its children.
  if (childCategory === "CANCELLED" || parentCategory === "CANCELLED") return false;

  // Only ever offer to move the parent FORWARD. A child moving back to Backlog
  // must not drag a parent whose other children are still in flight.
  return RANK[childCategory] > RANK[parentCategory];
}
