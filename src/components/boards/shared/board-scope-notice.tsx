"use client";

import { Filter } from "lucide-react";
import type { BoardScope } from "@/lib/boards/saved-filter";

/**
 * One line under a board's filter bar saying the board is narrowed by the
 * filter it was saved with. Without it a board saved from Issues looks like it
 * is missing items, because its scope never appears in the filter bar.
 */
export function BoardScopeNotice({ scope }: { scope: BoardScope }) {
  if (scope.kind === "none") return null;
  return (
    <p
      role="status"
      className="flex items-center gap-1.5 border-b px-4 py-1 text-xs text-muted-foreground"
    >
      <Filter className="h-3 w-3 shrink-0" aria-hidden />
      {scope.kind === "filter"
        ? "Showing only items that match the filter this board was saved with."
        : `This board shows no items: ${scope.reason}.`}
    </p>
  );
}
