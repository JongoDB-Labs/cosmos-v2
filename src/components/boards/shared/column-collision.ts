import {
  closestCorners,
  pointerWithin,
  type CollisionDetection,
} from "@dnd-kit/core";

/**
 * Collision detection for a board of columns holding cards.
 *
 * `closestCorners` alone scores every droppable by how near its corners are to
 * the dragged card, so a short or empty column loses to a tall neighbour or a
 * card next to it: dropping into an empty Backlog or Review lands nowhere, or
 * in the adjacent column. Ask what the pointer is actually over first — a card
 * beats the column it sits in, so reordering still works — and fall back to
 * `closestCorners` only when the pointer is over no droppable at all (a gap
 * between columns, or outside the board).
 */
export function columnCollision(
  isColumn: (id: string) => boolean,
): CollisionDetection {
  return (args) => {
    const under = pointerWithin(args);
    if (under.length > 0) {
      const cards = under.filter((c) => !isColumn(String(c.id)));
      return cards.length > 0 ? cards : under;
    }
    return closestCorners(args);
  };
}
