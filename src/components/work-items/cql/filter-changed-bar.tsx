"use client";

/**
 * "Filter changed — Save / Save as… / Discard" (Jira's behaviour, design
 * §10.4): shown when the query on screen is not the loaded saved filter's.
 * Compared by normalized query hash, so re-spacing or reordering an AND is
 * not a change.
 */
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { hashQuery } from "@/lib/query/normalize";
import { parseCql } from "@/lib/query/parser";
import { apiErrorText, useSavedFilterMutations, type SavedFilterDetail } from "./use-saved-filters";

/** Does `cql` say something other than the loaded filter? */
export function filterChanged(cql: string, loaded: SavedFilterDetail | undefined): boolean {
  if (!loaded || !cql.trim()) return false;
  const a = parseCql(cql);
  const b = parseCql(loaded.cql);
  // Text that doesn't parse is a change (it isn't the saved query).
  if (a.diagnostics.length || b.diagnostics.length) return cql.trim() !== loaded.cql.trim();
  return hashQuery(a.query) !== hashQuery(b.query);
}

export function FilterChangedBar({
  orgId,
  loaded,
  cql,
  onSaveAs,
  onDiscard,
}: {
  orgId: string;
  loaded: SavedFilterDetail;
  cql: string;
  onSaveAs: () => void;
  onDiscard: () => void;
}) {
  const { update } = useSavedFilterMutations(orgId);
  const blocked = !loaded.canEdit
    ? "You can't edit this filter. Save your version as a new one."
    : loaded.partiallyRestricted
      ? "Parts of this filter refer to things you can't see, so it can't be overwritten. Save it as a new filter."
      : null;

  return (
    <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--primary)] bg-[var(--primary-tint)] px-3 py-1.5 text-xs">
      <span className="font-medium">Filter changed</span>
      <span className="text-[var(--text-muted)]">“{loaded.name}” is not what’s shown.</span>
      <span className="ml-auto flex gap-1.5">
        <Button
          size="sm"
          disabled={!!blocked || update.isPending}
          title={blocked ?? `Save the query to “${loaded.name}”`}
          onClick={async () => {
            try {
              await update.mutateAsync({ id: loaded.id, cql });
              toast.success(`Saved “${loaded.name}”`);
            } catch (e) {
              toast.error(apiErrorText(e, "Couldn't save the filter."));
            }
          }}
        >
          Save
        </Button>
        <Button size="sm" variant="outline" onClick={onSaveAs}>
          Save as…
        </Button>
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          Discard
        </Button>
      </span>
    </div>
  );
}
