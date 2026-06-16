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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";
import { Search, X, UserCheck } from "lucide-react";
import { useCurrentUserId } from "@/lib/hooks/use-current-user";
import type { OrgMember, Cycle, CustomField } from "@/types/models";

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
  /**
   * Active custom-field constraints, keyed by CustomField.key. The value is the
   * selected option (SELECT/MULTI_SELECT), the search text (TEXT), or "true"
   * (CHECKBOX). An absent/empty key is inert. Only the filterable kinds
   * (SELECT / MULTI_SELECT / CHECKBOX / TEXT) are surfaced.
   */
  customFields: Record<string, string>;
}

export const emptyFilters: BoardFilters = {
  search: "",
  types: [],
  priorities: [],
  assigneeId: null,
  cycleId: null,
  swimlaneBy: "none",
  customFields: {},
};

/** Custom-field kinds the board filter bar surfaces a control for. */
const FILTERABLE_CUSTOM_KINDS = new Set(["SELECT", "MULTI_SELECT", "CHECKBOX", "TEXT"]);

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
  /**
   * Custom-field definitions for the current project. When supplied, a filter
   * control is rendered for each filterable field (SELECT / MULTI_SELECT /
   * CHECKBOX / TEXT). Omitted ⇒ no custom-field controls (backward compatible).
   */
  customFields?: CustomField[];
}

const WORK_ITEM_TYPES = ["EPIC", "STORY", "TASK", "BUG", "SUBTASK"] as const;
const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

/**
 * The Type filter (and the type color maps) key off the bare type — EPIC,
 * STORY, … — but a WorkItemType.key is sector-PREFIXED and lowercase
 * ("software.epic", "aec.rfi"). Normalize to the bare uppercase suffix so the
 * filter actually matches (this prefix mismatch is why filtering by a type
 * showed nothing on the board) and color lookups resolve.
 */
export function bareTypeKey(key: string | null | undefined): string {
  return (key ?? "").split(".").pop()?.toUpperCase() ?? "";
}

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
  // Custom-field constraints round-trip as repeated `cf=key~value` params (the
  // kind is re-derived from the field defs at apply time, so it isn't encoded).
  for (const [key, value] of Object.entries(filters.customFields ?? {})) {
    if (value) params.append("cf", `${key}~${value}`);
  }
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
  // Custom-field constraints: repeated `cf=key~value` (see serializeFilters).
  const customFields: Record<string, string> = {};
  const cfValues =
    typeof params.getAll === "function" ? params.getAll("cf") : [];
  for (const raw of cfValues) {
    const idx = raw.indexOf("~");
    if (idx < 1) continue;
    const key = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1);
    if (key && value) customFields[key] = value;
  }
  return {
    search: params.get("q") ?? "",
    types: types ? types.split(",").filter(Boolean) : [],
    priorities: priorities ? priorities.split(",").filter(Boolean) : [],
    assigneeId: params.get("assignee") || null,
    cycleId: params.get("cycle") || null,
    swimlaneBy: VALID_SWIMLANES.has(lane) ? (lane as SwimlaneKey) : "none",
    customFields,
  };
}

// Minimal structural type so `parseFilters` accepts both the native
// URLSearchParams and Next's read-only `useSearchParams()` return value
// without importing from next/navigation here.
type ReadonlyURLSearchParams = {
  get(name: string): string | null;
  getAll?(name: string): string[];
};

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
  customFields = [],
}: FilterBarProps) {
  const [searchFocused, setSearchFocused] = useState(false);
  const currentUserId = useCurrentUserId();
  // FR "Assigned to me": one-click filter to the current user on any board view.
  const assignedToMe =
    currentUserId !== null && filters.assigneeId === currentUserId;

  const filterableCustomFields = customFields.filter((f) =>
    FILTERABLE_CUSTOM_KINDS.has(f.fieldType),
  );

  const hasActiveCustom = Object.values(filters.customFields ?? {}).some(Boolean);

  const setCustom = (key: string, value: string | null) => {
    const next = { ...(filters.customFields ?? {}) };
    if (value) next[key] = value;
    else delete next[key];
    onFilterChange({ ...filters, customFields: next });
  };

  const hasFilters =
    filters.search !== "" ||
    filters.types.length > 0 ||
    filters.priorities.length > 0 ||
    filters.assigneeId !== null ||
    filters.cycleId !== null ||
    filters.swimlaneBy !== "none" ||
    hasActiveCustom;

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b bg-background/50">
      <div
        className={cn(
          "flex w-full items-center gap-1.5 rounded-lg border px-2 transition-colors sm:w-auto",
          searchFocused ? "border-ring ring-3 ring-ring/50" : "border-input"
        )}
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search tickets..."
          value={filters.search}
          onChange={(e) =>
            onFilterChange({ ...filters, search: e.target.value })
          }
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground sm:h-7 sm:w-40"
        />
      </div>

      {currentUserId && (
        <Button
          size="sm"
          variant={assignedToMe ? "default" : "outline"}
          aria-pressed={assignedToMe}
          className="h-7 gap-1.5"
          onClick={() =>
            onFilterChange({
              ...filters,
              assigneeId: assignedToMe ? null : currentUserId,
            })
          }
        >
          <UserCheck className="h-3.5 w-3.5" />
          Assigned to me
        </Button>
      )}

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
        <SearchableSelect
          size="sm"
          aria-label="Filter by assignee"
          className="h-7 text-xs"
          searchPlaceholder="Search people…"
          emptyText="No matching people"
          value={filters.assigneeId ?? "__all__"}
          onValueChange={(v) =>
            onFilterChange({
              ...filters,
              assigneeId: v && v !== "__all__" ? v : null,
            })
          }
          options={[
            { value: "__all__", label: "All" },
            ...members.map((m) => ({
              value: m.userId,
              label: m.user?.displayName ?? m.userId,
            })),
          ]}
        />
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

      {filterableCustomFields.map((f) => {
        const current = filters.customFields?.[f.key] ?? "";
        if (f.fieldType === "CHECKBOX") {
          const active = current === "true";
          return (
            <Button
              key={f.id}
              size="sm"
              variant={active ? "default" : "outline"}
              aria-pressed={active}
              className="h-7 gap-1.5"
              onClick={() => setCustom(f.key, active ? null : "true")}
            >
              {f.name}
            </Button>
          );
        }
        if (f.fieldType === "TEXT") {
          return (
            <div key={f.id} className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground mr-1">{f.name}:</span>
              <input
                type="text"
                aria-label={`Filter by ${f.name}`}
                placeholder="Contains…"
                value={current}
                onChange={(e) => setCustom(f.key, e.target.value || null)}
                className="h-7 w-32 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          );
        }
        // SELECT / MULTI_SELECT — pick one option to match.
        return (
          <div key={f.id} className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground mr-1">{f.name}:</span>
            <Select
              items={{
                __all__: "All",
                ...Object.fromEntries(f.options.map((o) => [o, o])),
              }}
              value={current || "__all__"}
              onValueChange={(v) => setCustom(f.key, v && v !== "__all__" ? v : null)}
            >
              <SelectTrigger
                size="sm"
                aria-label={`Filter by ${f.name}`}
                className="h-7 text-xs"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All</SelectItem>
                {f.options.map((o) => (
                  <SelectItem key={o} value={o}>
                    {o}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      })}

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

/**
 * Client-side predicate: does an item's stored custom-field values satisfy the
 * active `customFields` filter map? Used by board views that filter loaded
 * items in JS (mirrors the server-side JSON-path build in build-where.ts).
 *
 *   - SELECT / TEXT → the stored scalar equals (TEXT: contains, case-insensitive).
 *   - MULTI_SELECT → the stored array contains the chosen option.
 *   - CHECKBOX → the stored value is exactly `true` (filter value "true").
 * An unknown key or a field kind we don't filter on is treated as a pass-through.
 */
export function matchesCustomFieldFilters(
  itemCustomFields: Record<string, unknown> | null | undefined,
  active: Record<string, string>,
  defs: CustomField[],
): boolean {
  const entries = Object.entries(active).filter(([, v]) => v);
  if (entries.length === 0) return true;
  const values = itemCustomFields ?? {};
  const byKey = new Map(defs.map((d) => [d.key, d]));

  for (const [key, wanted] of entries) {
    const def = byKey.get(key);
    if (!def || !FILTERABLE_CUSTOM_KINDS.has(def.fieldType)) continue;
    const stored = values[key];
    switch (def.fieldType) {
      case "CHECKBOX":
        if (stored !== true) return false;
        break;
      case "MULTI_SELECT": {
        const arr = Array.isArray(stored) ? stored : [];
        if (!arr.includes(wanted)) return false;
        break;
      }
      case "TEXT": {
        const s = typeof stored === "string" ? stored : "";
        if (!s.toLowerCase().includes(wanted.toLowerCase())) return false;
        break;
      }
      default: // SELECT
        if (stored !== wanted) return false;
        break;
    }
  }
  return true;
}
