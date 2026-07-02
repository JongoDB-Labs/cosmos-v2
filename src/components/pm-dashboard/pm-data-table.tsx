"use client";
/**
 * Shared shell for every PM-dashboard register (risks, deliverables, blockers,
 * changes, CLINs, schedule, staffing, vendors). Composes the boards' DataTable
 * — which already provides SORTABLE column headers, ROW SELECTION, a RIGHT-CLICK
 * context menu + a ⋯ actions column — and layers on the register header
 * (title/subtitle/New), a text SEARCH box, and a BULK-action bar that appears
 * when rows are selected. Each register supplies its own columns, row-actions,
 * bulk actions, and detail drawer.
 */
import { useMemo, useState } from "react";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { Plus, Search, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import type { ActionMenuGroup } from "@/components/ui/action-menu";

export interface PmDataTableProps<T extends { id: string }> {
  title: string;
  subtitle?: React.ReactNode;
  rows: T[];
  columns: ColumnDef<T>[];
  /** Text search — filters `rows` via `searchText(row)` (space-joined, lower-cased). */
  search: string;
  onSearchChange: (s: string) => void;
  searchText: (row: T) => string;
  searchPlaceholder?: string;
  onRowClick?: (row: T) => void;
  rowActions?: (row: T) => ActionMenuGroup[];
  onNew?: () => void;
  newLabel?: string;
  /** Selection + bulk. When `renderBulkActions` is set, rows get checkboxes and a
   *  sticky bulk bar renders the entity-specific actions for the selected ids. */
  renderBulkActions?: (ids: string[], clear: () => void) => React.ReactNode;
  emptyIcon: LucideIcon;
  emptyTitle: string;
  emptyDescription?: string;
}

export function PmDataTable<T extends { id: string }>({
  title,
  subtitle,
  rows,
  columns,
  search,
  onSearchChange,
  searchText,
  searchPlaceholder = "Filter…",
  onRowClick,
  rowActions,
  onNew,
  newLabel = "New",
  renderBulkActions,
  emptyIcon,
  emptyTitle,
  emptyDescription,
}: PmDataTableProps<T>) {
  const [selection, setSelection] = useState<RowSelectionState>({});

  const view = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => searchText(r).toLowerCase().includes(q));
  }, [rows, search, searchText]);

  const selectedIds = useMemo(
    () => Object.keys(selection).filter((id) => selection[id]),
    [selection],
  );
  const clearSelection = () => setSelection({});

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text)]">{title}</h2>
          {subtitle && <p className="text-sm text-[var(--text-muted)]">{subtitle}</p>}
        </div>
        {onNew && (
          <Button onClick={onNew}>
            <Plus className="size-4" /> {newLabel}
          </Button>
        )}
      </div>

      <div className="relative max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-[var(--text-muted)]" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="pl-8"
        />
      </div>

      {view.length === 0 ? (
        <EmptyState
          icon={emptyIcon}
          title={search ? "No matches" : emptyTitle}
          description={search ? "Try a different filter." : emptyDescription}
          action={!search && onNew ? <Button onClick={onNew}><Plus className="size-4" /> {newLabel}</Button> : undefined}
        />
      ) : (
        <DataTable
          columns={columns}
          data={view}
          getRowId={(r) => r.id}
          onRowClick={onRowClick}
          rowActions={rowActions}
          rowSelection={renderBulkActions ? selection : undefined}
          onRowSelectionChange={renderBulkActions ? setSelection : undefined}
        />
      )}

      {renderBulkActions && selectedIds.length > 0 && (
        <div className="sticky bottom-4 z-10 mx-auto flex flex-wrap items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 shadow-[var(--shadow-soft)]">
          <span className="px-1 text-sm font-medium text-[var(--text)]">
            {selectedIds.length} selected
          </span>
          <Button variant="ghost" size="icon-xs" aria-label="Clear selection" onClick={clearSelection}>
            <X className="size-3.5" />
          </Button>
          <div className="mx-1 h-4 w-px bg-[var(--border)]" />
          {renderBulkActions(selectedIds, clearSelection)}
        </div>
      )}
    </div>
  );
}
