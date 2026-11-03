"use client";

import { Filter } from "lucide-react";
import type { BoardScope } from "@/lib/boards/saved-filter";

/**
 * Says the board is narrowed by the filter it was saved with.
 *
 * Without it a board saved from Issues looks like it is missing items, because
 * its scope never appears in the filter bar.
 *
 * This used to own a BAND of its own (`border-b px-4 py-1`), conditionally, so
 * a board saved from Issues stacked a fourth horizontal band above the first
 * card. It is now a chip passed to the filter surface's `notice` slot, which
 * renders it inside the band the filters already occupy: it says the same KIND
 * of thing those controls say -- what is narrowing this board -- so that is
 * where it belongs, and it costs no vertical space there. See ffe324aa.
 *
 * Still `role="status"`: it appears and disappears with the board's scope, and
 * a sighted user sees it arrive.
 */
export function BoardScopeNotice({ scope }: { scope: BoardScope }) {
  if (scope.kind === "none") return null;
  const empty = scope.kind !== "filter";
  return (
    <p
      role="status"
      className={
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs " +
        (empty
          ? "bg-[var(--destructive)]/10 text-[var(--destructive)]"
          : "bg-muted text-muted-foreground")
      }
    >
      <Filter className="h-3 w-3 shrink-0" aria-hidden />
      {scope.kind === "filter"
        ? "Showing only items that match the filter this board was saved with."
        : `This board shows no items: ${scope.reason}.`}
    </p>
  );
}
