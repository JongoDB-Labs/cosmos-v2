"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Search, X } from "lucide-react";
import type { OrgMember, Cycle } from "@/types/models";

/**
 * Axis a Kanban board can be grouped into horizontal swimlanes by. `"none"`
 * is the default (a single flat row of columns, identical to legacy behavior).
 * This lives on BoardFilters so it round-trips through the shareable URL with
 * the rest of the filter state, but the control is only surfaced when a
 * consumer opts in via `showSwimlane` — the table view never sees it.
 */
export type SwimlaneKey =
  | "none"
  | "assignee"
  | "priority"
  | "type"
  | "cycle"
  | "parent";

export const SWIMLANE_OPTIONS: { value: SwimlaneKey; label: string }[] = [
  { value: "none", label: "None" },
  { value: "assignee", label: "Assignee" },
  { value: "priority", label: "Priority" },
  { value: "type", label: "Type" },
  { value: "cycle", label: "Cycle" },
  { value: "parent", label: "Parent" },
];

export interface BoardFilters {
  search: string;
  types: string[];
  priorities: string[];
  assigneeId: string | null;
  cycleId: string | null;
  swimlaneBy: SwimlaneKey;
}

export const emptyFilters: BoardFilters = {
  search: "",
  types: [],
  priorities: [],
  assigneeId: null,
  cycleId: null,
  swimlaneBy: "none",
};

interface FilterBarProps {
  filters: BoardFilters;
  onFilterChange: (filters: BoardFilters) => void;
  members: OrgMember[];
  cycles: Cycle[];
  /**
   * When true, render the board-only "Swimlanes" group-by control. Defaults to
   * false so non-board consumers (e.g. the table view) are unaffected — keeping
   * this component backward-compatible.
   */
  showSwimlane?: boolean;
}

const WORK_ITEM_TYPES = ["EPIC", "STORY", "TASK", "BUG", "SUBTASK"] as const;
const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

const VALID_SWIMLANES = new Set<string>(SWIMLANE_OPTIONS.map((o) => o.value));

/**
 * Serialize active filters into a URLSearchParams query string. Only non-empty
 * values are written so a pristine board produces an empty (clean) URL. Mirror
 * of `parseFilters` below — keep the two in lock-step.
 */
export function serializeFilters(filters: BoardFilters): string {
  const params = new URLSearchParams();
  if (filters.search) params.set("q", filters.search);
  if (filters.types.length > 0) params.set("type", filters.types.join(","));
  if (filters.priorities.length > 0)
    params.set("priority", filters.priorities.join(","));
  if (filters.assigneeId) params.set("assignee", filters.assigneeId);
  if (filters.cycleId) params.set("cycle", filters.cycleId);
  if (filters.swimlaneBy && filters.swimlaneBy !== "none")
    params.set("lane", filters.swimlaneBy);
  return params.toString();
}

/**
 * Reconstruct BoardFilters from a URLSearchParams (read on mount so a shared /
 * reloaded board restores its filtered + grouped view). Unknown values fall
 * back to the empty defaults.
 */
export function parseFilters(
  params: URLSearchParams | ReadonlyURLSearchParams,
): BoardFilters {
  const lane = params.get("lane") ?? "";
  const types = params.get("type");
  const priorities = params.get("priority");
  return {
    search: params.get("q") ?? "",
    types: types ? types.split(",").filter(Boolean) : [],
    priorities: priorities ? priorities.split(",").filter(Boolean) : [],
    assigneeId: params.get("assignee") || null,
    cycleId: params.get("cycle") || null,
    swimlaneBy: VALID_SWIMLANES.has(lane) ? (lane as SwimlaneKey) : "none",
  };
}

// Minimal structural type so `parseFilters` accepts both the native
// URLSearchParams and Next's read-only `useSearchParams()` return value
// without importing from next/navigation here.
type ReadonlyURLSearchParams = { get(name: string): string | null };

function MultiToggle({
  label,
  options,
  selected,
  onChange,
  colorMap,
}: {
  label: string;
  options: readonly string[];
  selected: string[];
  onChange: (values: string[]) => void;
  colorMap?: Record<string, string>;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-muted-foreground mr-1">{label}:</span>
      {options.map((opt) => {
        const active = selected.includes(opt);
        return (
          <button
            key={opt}
            type="button"
            onClick={() => {
              if (active) {
                onChange(selected.filter((s) => s !== opt));
              } else {
                onChange([...selected, opt]);
              }
            }}
            className={cn(
              "rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
              active
                ? colorMap?.[opt] ?? "bg-primary/20 text-primary"
                : "bg-muted/50 text-muted-foreground hover:bg-muted"
            )}
          >
            {opt.charAt(0) + opt.slice(1).toLowerCase()}
          </button>
        );
      })}
    </div>
  );
}

const typeColors: Record<string, string> = {
  EPIC: "bg-purple-500/20 text-purple-400",
  STORY: "bg-blue-500/20 text-blue-400",
  TASK: "bg-cyan-500/20 text-cyan-400",
  BUG: "bg-red-500/20 text-red-400",
  SUBTASK: "bg-muted text-muted-foreground",
};

const priorityColors: Record<string, string> = {
  CRITICAL: "bg-red-500/20 text-red-400",
  HIGH: "bg-orange-500/20 text-orange-400",
  MEDIUM: "bg-yellow-500/20 text-yellow-400",
  LOW: "bg-green-500/20 text-green-400",
};

export function FilterBar({
  filters,
  onFilterChange,
  members,
  cycles,
  showSwimlane = false,
}: FilterBarProps) {
  const [searchFocused, setSearchFocused] = useState(false);

  const hasFilters =
    filters.search !== "" ||
    filters.types.length > 0 ||
    filters.priorities.length > 0 ||
    filters.assigneeId !== null ||
    filters.cycleId !== null ||
    filters.swimlaneBy !== "none";

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b bg-background/50">
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-lg border px-2 transition-colors",
          searchFocused ? "border-ring ring-3 ring-ring/50" : "border-input"
        )}
      >
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search tickets..."
          value={filters.search}
          onChange={(e) =>
            onFilterChange({ ...filters, search: e.target.value })
          }
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          className="h-7 w-40 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>

      <MultiToggle
        label="Type"
        options={WORK_ITEM_TYPES}
        selected={filters.types}
        onChange={(types) => onFilterChange({ ...filters, types })}
        colorMap={typeColors}
      />

      <MultiToggle
        label="Priority"
        options={PRIORITIES}
        selected={filters.priorities}
        onChange={(priorities) => onFilterChange({ ...filters, priorities })}
        colorMap={priorityColors}
      />

      <div className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground mr-1">Assignee:</span>
        <Select
          items={{
            __all__: "All",
            ...Object.fromEntries(
              members.map((m) => [m.userId, m.user?.displayName ?? m.userId]),
            ),
          }}
          value={filters.assigneeId ?? "__all__"}
          onValueChange={(v) =>
            onFilterChange({
              ...filters,
              assigneeId: v && v !== "__all__" ? v : null,
            })
          }
        >
          <SelectTrigger size="sm" aria-label="Filter by assignee" className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.userId} value={m.userId}>
                {m.user?.displayName ?? m.userId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {cycles.length > 0 && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground mr-1">Cycle:</span>
          <Select
            items={{
              __all__: "All",
              ...Object.fromEntries(cycles.map((s) => [s.id, s.name])),
            }}
            value={filters.cycleId ?? "__all__"}
            onValueChange={(v) =>
              onFilterChange({
                ...filters,
                cycleId: v && v !== "__all__" ? v : null,
              })
            }
          >
            <SelectTrigger size="sm" aria-label="Filter by cycle" className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All</SelectItem>
              {cycles.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {showSwimlane && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground mr-1">Swimlanes:</span>
          <Select
            items={Object.fromEntries(
              SWIMLANE_OPTIONS.map((o) => [o.value, o.label]),
            )}
            value={filters.swimlaneBy}
            onValueChange={(v) =>
              onFilterChange({
                ...filters,
                swimlaneBy: VALID_SWIMLANES.has(v as string)
                  ? (v as SwimlaneKey)
                  : "none",
              })
            }
          >
            <SelectTrigger
              size="sm"
              aria-label="Group into swimlanes"
              className="h-7 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SWIMLANE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {hasFilters && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onFilterChange(emptyFilters)}
          className="gap-1 text-muted-foreground"
        >
          <X className="h-3 w-3" />
          Clear
        </Button>
      )}
    </div>
  );
}
