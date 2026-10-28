"use client";

/**
 * The "Saved" menu (query design §10.4), replacing the Saved views picker
 * where the org has CQL on.
 *
 * It was labelled "Filters", which is where FR ad579c82 went looking for a way
 * to ADD one: "i should simply be able to add the filters from the dropdown on
 * the right". Adding a condition belongs to the query bar below (chips, and
 * now "Add filter" beside the CQL editor too); this holds saved ones only, and
 * now says so.
 *
 *   Favorites       starred filters; click runs
 *   My filters      yours, each with its actions
 *   Shared with me  others' filters, by how they were shared
 *   Recently used   the last five you ran in this browser
 *
 * Per filter: Run, Star / Unstar, Edit details, Copy CQL, Copy link, Subscribe, Delete.
 * "Copy CQL" copies the text as you may see it (‹restricted› parts and all).
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Filter, Star } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { recentFilterIds, useSavedFilterMutations, useSavedFilters, type SavedFilter, type SavedFilterDetail } from "./use-saved-filters";

export interface FiltersMenuProps {
  orgId: string;
  orgSlug: string;
  /** The filter currently loaded, if any (marked in the list). */
  activeId: string | null;
  onRun: (f: SavedFilter) => void;
  onEdit: (f: SavedFilter) => void;
  /** Open the Subscribe dialog for this filter. */
  onSubscribe: (f: SavedFilter) => void;
}

const SHARED_AS: Record<SavedFilter["visibility"], string> = {
  PRIVATE: "Shared with you to edit",
  TEAM: "Your teams",
  PROJECT: "Your projects",
  ORG: "Everyone",
};

export function FiltersMenu({ orgId, orgSlug, activeId, onRun, onEdit, onSubscribe }: FiltersMenuProps) {
  const { data: filters = [] } = useSavedFilters(orgId);
  const { star, remove } = useSavedFilterMutations(orgId);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const recent = useMemo(() => (open ? recentFilterIds() : []), [open]);

  const match = (f: SavedFilter) => !q.trim() || f.name.toLowerCase().includes(q.trim().toLowerCase());
  const shown = filters.filter(match);
  const favorites = shown.filter((f) => f.favorite).sort((a, b) => (a.favoriteOrder ?? 0) - (b.favoriteOrder ?? 0));
  const mine = shown.filter((f) => f.mine);
  const shared = (["TEAM", "PROJECT", "ORG", "PRIVATE"] as const)
    .map((v) => ({ v, items: shown.filter((f) => !f.mine && f.visibility === v) }))
    .filter((g) => g.items.length > 0);
  const recents = recent.map((id) => filters.find((f) => f.id === id)).filter((f): f is SavedFilter => !!f && match(f));

  async function copyCql(f: SavedFilter) {
    try {
      const d = await jsonFetch<SavedFilterDetail>(`/api/v1/orgs/${orgId}/saved-views/${f.id}`);
      await navigator.clipboard?.writeText(d.cql);
      toast.success("Query copied");
    } catch {
      toast.error("Couldn't copy the query.");
    }
  }
  function copyLink(f: SavedFilter) {
    try {
      void navigator.clipboard?.writeText(`${window.location.origin}/${orgSlug}/issues?filter=${f.id}`);
      toast.success("Link copied");
    } catch {
      /* clipboard unavailable */
    }
  }

  const row = (f: SavedFilter) => (
    <DropdownMenuSub key={f.id}>
      <DropdownMenuSubTrigger className={cn(f.id === activeId && "font-semibold")}>
        <Star className={cn("mr-2 h-3.5 w-3.5", f.favorite ? "fill-current text-[var(--primary)]" : "text-[var(--text-muted)]")} aria-hidden />
        <span className="truncate">{f.name}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-44">
        <DropdownMenuItem onClick={() => onRun(f)}>Run</DropdownMenuItem>
        <DropdownMenuItem onClick={() => star.mutate({ id: f.id, on: !f.favorite })}>{f.favorite ? "Unstar" : "Star"}</DropdownMenuItem>
        {f.canEdit && <DropdownMenuItem onClick={() => onEdit(f)}>Edit details…</DropdownMenuItem>}
        <DropdownMenuItem onClick={() => void copyCql(f)}>Copy CQL</DropdownMenuItem>
        <DropdownMenuItem onClick={() => copyLink(f)}>Copy link</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onSubscribe(f)}>Subscribe…</DropdownMenuItem>
        {f.canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                if (window.confirm(`Delete "${f.name}"? Anyone it's shared with loses it too.`)) remove.mutate(f.id);
              }}
            >
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={<button type="button" aria-label="Saved filters" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5")} />}
      >
        <Filter className="h-4 w-4" /> Saved
        <ChevronDown className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[70vh] w-72 overflow-y-auto">
        <div className="p-1.5" onKeyDown={(e) => e.stopPropagation()}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a filter…" aria-label="Find a filter" className="h-8 text-sm" />
        </div>
        {filters.length === 0 && <p className="px-3 py-2 text-xs text-[var(--text-muted)]">No saved filters yet. Run a query, then Save filter.</p>}
        {favorites.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Favorites</DropdownMenuLabel>
            {favorites.map((f) => (
              <DropdownMenuItem key={`fav-${f.id}`} onClick={() => onRun(f)}>
                <Star className="mr-2 h-3.5 w-3.5 fill-current text-[var(--primary)]" aria-hidden />
                <span className="truncate">{f.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
        {mine.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>My filters</DropdownMenuLabel>
            {mine.map(row)}
          </DropdownMenuGroup>
        )}
        {shared.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Shared with me</DropdownMenuLabel>
            {shared.map((g) => (
              <div key={g.v}>
                <p className="px-2 pt-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{SHARED_AS[g.v]}</p>
                {g.items.map(row)}
              </div>
            ))}
          </DropdownMenuGroup>
        )}
        {recents.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Recently used</DropdownMenuLabel>
            {recents.map((f) => (
              <DropdownMenuItem key={`recent-${f.id}`} onClick={() => onRun(f)}>
                <span className="truncate">{f.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
