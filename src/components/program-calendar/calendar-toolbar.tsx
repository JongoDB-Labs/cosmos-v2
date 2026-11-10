"use client";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuGroup,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChipCategory } from "./event-chip";

export type CalendarViewMode = "day" | "week" | "month";
export type SortKey = "start" | "owner" | "category";

export interface OwnerLane {
  key: string;
  label: string;
  count: number;
}

export interface CustomFilters {
  showOnDashboardOnly: boolean;
  customerAttending: boolean;
  hasDeliverable: boolean;
}

/**
 * The calendar's controls.
 *
 * Categories and Owners are OVERLAYS, not a single-choice filter: each is a
 * checkbox with a live count, so the question the feature request asks —
 * "show me the agile cadence and the program events together, but not Outlook
 * today" — is answered by ticking boxes rather than by switching view.
 *
 * The counts deliberately ignore the filter they sit next to. A category you
 * have switched off still reports how many events it would bring back, which
 * is what makes it obvious that something is hidden rather than absent — the
 * failure mode where an empty board reads as "there is no data".
 */
export function CalendarToolbar({
  label,
  view,
  onView,
  onPrev,
  onNext,
  onToday,
  categories,
  categoryCounts,
  selectedCategories,
  onToggleCategory,
  onAllCategories,
  owners,
  selectedOwners,
  onToggleOwner,
  sort,
  onSort,
  filters,
  onFilters,
  onNew,
  canCreate,
}: {
  label: string;
  view: CalendarViewMode;
  onView: (v: CalendarViewMode) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  categories: ChipCategory[];
  categoryCounts: Record<string, number>;
  selectedCategories: string[];
  onToggleCategory: (id: string) => void;
  onAllCategories: (all: boolean) => void;
  owners: OwnerLane[];
  selectedOwners: string[];
  onToggleOwner: (key: string) => void;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  filters: CustomFilters;
  onFilters: (f: CustomFilters) => void;
  onNew: () => void;
  canCreate: boolean;
}) {
  // `DropdownMenuTrigger` renders its own button via className, as filter-bar
  // and the other board menus do. It must NOT be given `render={<Button/>}`:
  // that form compiles and renders a perfectly good-looking button which never
  // opens the menu, because the trigger's behaviour is not forwarded onto a
  // composite component. All three overlay menus were dead that way, and
  // nothing but opening the page would have shown it.
  const triggerClass = cn(
    "inline-flex h-8 items-center gap-1 rounded-md border border-input px-2.5 text-xs font-medium transition-colors",
    "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
  );

  // No selection means "everything", which is what an empty filter should mean
  // and is also the state a fresh visitor arrives in.
  const allCats = selectedCategories.length === 0;
  const activeFilters = Object.values(filters).filter(Boolean).length;

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" onClick={onPrev} aria-label="Previous">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={onNext} aria-label="Next">
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={onToday}>
          Today
        </Button>
      </div>

      <h2 className="ml-1 text-lg font-semibold tracking-tight">{label}</h2>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger className={triggerClass}>
            Owners
            {selectedOwners.length ? ` (${selectedOwners.length})` : ""}
            <ChevronDown className="h-3 w-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64">
            {/* A label is a Base UI group PART: outside <Menu.Group> it throws
                "MenuGroupContext is missing" and the whole menu fails to
                render — the trigger then looks fine and simply never opens. */}
            <DropdownMenuGroup>
            <DropdownMenuLabel>Owners</DropdownMenuLabel>
            {owners.map((o) => (
              <DropdownMenuCheckboxItem
                key={o.key}
                checked={selectedOwners.includes(o.key)}
                onCheckedChange={() => onToggleOwner(o.key)}
              >
                <span className="flex-1 truncate">{o.label}</span>
                <span className="ml-2 tabular-nums text-xs text-muted-foreground">{o.count}</span>
              </DropdownMenuCheckboxItem>
            ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={sort} onValueChange={(v) => onSort(v as SortKey)}>
              <DropdownMenuLabel>Sort events by</DropdownMenuLabel>
              <DropdownMenuRadioItem value="owner">Owner</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="category">Category</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="start">Start time</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger className={triggerClass}>
            Categories
            <span className="text-muted-foreground">
              {allCats ? "All" : selectedCategories.length}
            </span>
            <ChevronDown className="h-3 w-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-72">
            <DropdownMenuGroup>
            <DropdownMenuLabel>Show categories</DropdownMenuLabel>
            {categories.map((c) => (
              <DropdownMenuCheckboxItem
                key={c.id}
                checked={allCats || selectedCategories.includes(c.id)}
                onCheckedChange={() => onToggleCategory(c.id)}
              >
                <span
                  aria-hidden
                  className="mr-2 inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: `rgb(${c.tintRgb})` }}
                />
                <span className="flex-1 truncate">{c.name}</span>
                <span className="ml-2 tabular-nums text-xs text-muted-foreground">
                  {categoryCounts[c.id] ?? 0}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onAllCategories(true)}>Select all</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onAllCategories(false)}>Clear</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger className={triggerClass}>
            Filters{activeFilters ? ` (${activeFilters})` : ""}
            <ChevronDown className="h-3 w-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64">
            <DropdownMenuGroup>
            <DropdownMenuLabel>Custom filter</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={filters.showOnDashboardOnly}
              onCheckedChange={(v) => onFilters({ ...filters, showOnDashboardOnly: !!v })}
            >
              On the dashboard only
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={filters.customerAttending}
              onCheckedChange={(v) => onFilters({ ...filters, customerAttending: !!v })}
            >
              Customer attending
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={filters.hasDeliverable}
              onCheckedChange={(v) => onFilters({ ...filters, hasDeliverable: !!v })}
            >
              Has a deliverable
            </DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() =>
                onFilters({
                  showOnDashboardOnly: false,
                  customerAttending: false,
                  hasDeliverable: false,
                })
              }
            >
              Clear
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center rounded-md border p-0.5" role="group" aria-label="Calendar view">
          {/* The LABEL is capitalised, not the CSS. `capitalize` on a lowercase
              literal leaves the accessible name lowercase, so a screen reader
              announces "day" and label-in-name no longer matches what is on
              screen — the same defect the a11y spec records against OKR's old
              view switcher. */}
          {([["day", "Day"], ["week", "Week"], ["month", "Month"]] as const).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => onView(v)}
              aria-pressed={view === v}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {canCreate ? (
          <Button size="sm" onClick={onNew}>
            New event
          </Button>
        ) : null}
      </div>
    </div>
  );
}
