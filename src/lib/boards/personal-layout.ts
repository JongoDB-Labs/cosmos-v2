import type { BuilderWidget } from "@/types/models";

/**
 * A person's own arrangement of a dashboard, as `boards/[boardId]/my-layout`
 * returns it. `null` means they use the shared layout.
 *
 * Client-safe: the route's contract carries the validation; this is only the
 * shape the view and the builder read.
 */
export interface PersonalLayoutResponse {
  layout: { widgets: BuilderWidget[]; updatedAt: string } | null;
}

/**
 * The most one saved layout may weigh, serialised. A layout is free-form JSON
 * (a text block's content, a link list's lines) stored once per person per
 * board, so it is bounded by size and not only by widget count.
 */
export const PERSONAL_LAYOUT_MAX_BYTES = 64 * 1024;
