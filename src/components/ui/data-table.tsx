"use client";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  getExpandedRowModel,
  getGroupedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type ExpandedState,
  type PaginationState,
  type RowSelectionState,
  type GroupingState,
} from "@tanstack/react-table";
import { Fragment, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "./checkbox";

export interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  data: T[];
  emptyState?: React.ReactNode;
  /** When provided, each row gets an expand chevron and renders this panel
   * underneath the expanded row. Receives the row's original data. */
  renderExpanded?: (row: T) => React.ReactNode;
  /** Default false. Enables pagination + page-size selector. */
  pagination?: boolean | { pageSize?: number; pageSizeOptions?: number[] };
  /** Initial pagination state (uncontrolled). */
  initialPageSize?: number;
  /** A stable row identifier — used for keys and expansion state.
   * Defaults to `String(row.id)` if the row has an `id` field. */
  getRowId?: (row: T) => string;
  /** When provided, each row gains a checkbox column and selection state is
   * managed externally. The Map shape is `{ [rowId]: true }`. */
  rowSelection?: RowSelectionState;
  onRowSelectionChange?: (next: RowSelectionState) => void;
  /** When non-empty, rows are grouped by the listed column accessor keys. */
  grouping?: GroupingState;
  onGroupingChange?: (next: GroupingState) => void;
  /** Map a (column id, raw grouping value) pair to a human-readable label.
   * Used to render grouped row headers — e.g. turn `IN_PROGRESS` into "In
   * progress". Without this, the raw value is shown. */
  getGroupLabel?: (columnId: string, value: unknown) => React.ReactNode;
  /** Add sticky top-of-viewport header */
  stickyHeader?: boolean;
  /** When provided, clicking a (non-grouped) row calls this with the row's
   * original data, and rows get a pointer cursor. Interactive cell content
   * (buttons/links/menus) should stopPropagation so it doesn't also fire this. */
  onRowClick?: (row: T) => void;
}

export function DataTable<T>({
  columns,
  data,
  emptyState,
  renderExpanded,
  pagination,
  initialPageSize,
  getRowId,
  rowSelection,
  onRowSelectionChange,
  grouping,
  onGroupingChange,
  getGroupLabel,
  stickyHeader,
  onRowClick,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const paginationObj = typeof pagination === "object" ? pagination : null;
  const [paginationState, setPaginationState] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: initialPageSize ?? paginationObj?.pageSize ?? 20,
  });

  const pageSizeOptions = paginationObj?.pageSizeOptions ?? [10, 20, 50, 100];
  const paginate = Boolean(pagination);

  const columnsWithSelection = useMemo<ColumnDef<T>[]>(() => {
    if (rowSelection === undefined) return columns;
    const selectionCol: ColumnDef<T> = {
      id: "__select",
      size: 36,
      enableSorting: false,
      enableGrouping: false,
      header: ({ table }) => (
        <Checkbox
          checked={table.getIsAllPageRowsSelected()}
          indeterminate={table.getIsSomePageRowsSelected()}
          onChange={(e) => table.toggleAllPageRowsSelected(e.target.checked)}
          aria-label="Select all"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          onChange={(e) => row.toggleSelected(e.target.checked)}
          aria-label="Select row"
        />
      ),
    };
    return [selectionCol, ...columns];
  }, [columns, rowSelection]);

  const table = useReactTable({
    data,
    columns: columnsWithSelection,
    state: {
      sorting,
      expanded,
      ...(paginate ? { pagination: paginationState } : {}),
      ...(rowSelection !== undefined ? { rowSelection } : {}),
      ...(grouping !== undefined ? { grouping } : {}),
    },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    onPaginationChange: setPaginationState,
    onRowSelectionChange: onRowSelectionChange
      ? (updater) => {
          const next =
            typeof updater === "function" ? updater(rowSelection ?? {}) : updater;
          onRowSelectionChange(next);
        }
      : undefined,
    onGroupingChange: onGroupingChange
      ? (updater) => {
          const next =
            typeof updater === "function" ? updater(grouping ?? []) : updater;
          onGroupingChange(next);
        }
      : undefined,
    enableRowSelection: rowSelection !== undefined,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel:
      renderExpanded || grouping !== undefined ? getExpandedRowModel() : undefined,
    getPaginationRowModel: paginate ? getPaginationRowModel() : undefined,
    getGroupedRowModel: grouping !== undefined ? getGroupedRowModel() : undefined,
    getRowCanExpand: renderExpanded ? () => true : undefined,
    getRowId: getRowId
      ? (row) => getRowId(row)
      : (row, i) => {
          const r = row as { id?: unknown };
          return r?.id != null ? String(r.id) : String(i);
        },
  });

  if (data.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  const rows = table.getRowModel().rows;
  const expandableColCount = columnsWithSelection.length + (renderExpanded ? 1 : 0);

  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
      <table className="w-full text-sm block md:table">
        <thead
          className={cn(
            "hidden md:table-header-group",
            stickyHeader && "sticky top-0 z-10 bg-[var(--surface)]",
          )}
        >
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="border-b border-[var(--border)]">
              {renderExpanded ? <th aria-hidden className="w-10" /> : null}
              {hg.headers.map((h) => {
                const canSort = h.column.getCanSort();
                const sortDir = h.column.getIsSorted();
                const SortIcon =
                  sortDir === "asc"
                    ? ArrowUp
                    : sortDir === "desc"
                      ? ArrowDown
                      : ArrowUpDown;
                return (
                  <th
                    key={h.id}
                    aria-sort={
                      sortDir === "asc"
                        ? "ascending"
                        : sortDir === "desc"
                          ? "descending"
                          : canSort
                            ? "none"
                            : undefined
                    }
                    className="text-left text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]"
                  >
                    {canSort ? (
                      // A real <button> so sorting is keyboard-operable
                      // (Enter/Space); the <th> keeps aria-sort for AT. The
                      // button carries the cell padding + w-full so the whole
                      // header cell stays a click target (as the old <th> was).
                      <button
                        type="button"
                        onClick={h.column.getToggleSortingHandler()}
                        className="flex w-full cursor-pointer select-none items-center gap-1 px-4 py-3 font-semibold uppercase tracking-wider hover:text-[var(--text)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <SortIcon
                          className={cn(
                            "h-3 w-3",
                            sortDir ? "opacity-100 text-[var(--text)]" : "opacity-50",
                          )}
                        />
                      </button>
                    ) : (
                      <span className="flex items-center gap-1 px-4 py-3">
                        {flexRender(h.column.columnDef.header, h.getContext())}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody className="block md:table-row-group">
          {rows.map((row) => {
            // Grouped row — render a single full-width header cell with chevron
            if (row.getIsGrouped()) {
              return (
                <Fragment key={row.id}>
                  <tr className="bg-[var(--bg)] border-b border-[var(--border)]/40">
                    <td
                      colSpan={expandableColCount}
                      className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]"
                    >
                      {/* Real <button> so the group expand/collapse is
                          keyboard-operable (Enter/Space). Carries the cell
                          padding + w-full so the whole row stays clickable. */}
                      <button
                        type="button"
                        onClick={row.getToggleExpandedHandler()}
                        aria-expanded={row.getIsExpanded()}
                        className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 uppercase tracking-wide hover:text-[var(--text)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                      >
                        <ChevronRight
                          className={cn(
                            "h-3 w-3 transition-transform",
                            row.getIsExpanded() && "rotate-90",
                          )}
                        />
                        {getGroupLabel
                          ? getGroupLabel(row.groupingColumnId ?? "", row.groupingValue)
                          : (row.groupingValue as React.ReactNode)}
                        {" "}({row.subRows.length})
                      </button>
                    </td>
                  </tr>
                </Fragment>
              );
            }
            return (
              <Fragment key={row.id}>
                <tr
                  onClick={
                    onRowClick ? () => onRowClick(row.original) : undefined
                  }
                  className={cn(
                    "group block space-y-2 border-b border-[var(--border)]/40 p-4 transition-colors last:border-0 hover:bg-[var(--bg)] md:table-row md:space-y-0 md:p-0",
                    row.getIsSelected() && "bg-[var(--primary-tint)]/40",
                    onRowClick && "cursor-pointer",
                  )}
                >
                  {renderExpanded ? (
                    <td className="hidden w-10 px-2 py-3 align-top md:table-cell">
                      <button
                        type="button"
                        aria-label={row.getIsExpanded() ? "Collapse row" : "Expand row"}
                        onClick={(e) => {
                          e.stopPropagation();
                          row.toggleExpanded();
                        }}
                        className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]"
                      >
                        <ChevronRight
                          className={cn(
                            "h-4 w-4 transition-transform",
                            row.getIsExpanded() && "rotate-90",
                          )}
                        />
                      </button>
                    </td>
                  ) : null}
                  {row.getVisibleCells().map((cell) => {
                    // Only string headers become the mobile data-label. A
                    // function/JSX header would otherwise be String()'d to its
                    // source code, which differs between the server and client
                    // bundles → a hydration attribute mismatch.
                    const rawHeader = cell.column.columnDef.header;
                    const headerText =
                      typeof rawHeader === "string" ? rawHeader : "";
                    return (
                      <td
                        key={cell.id}
                        data-label={headerText}
                        className="block px-0 py-1 before:mb-0.5 before:block before:text-xs before:font-semibold before:uppercase before:tracking-wider before:text-[var(--text-muted)] before:content-[attr(data-label)] first:group-hover:md:pl-[14px] group-hover:md:border-l-2 group-hover:md:border-l-[var(--primary)] md:table-cell md:px-4 md:py-3 md:before:hidden"
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
                {renderExpanded && row.getIsExpanded() && (
                  <tr className="bg-[var(--bg)]">
                    <td
                      colSpan={expandableColCount}
                      className="block border-b border-[var(--border)]/40 px-4 py-3 md:table-cell"
                    >
                      {renderExpanded(row.original)}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      {paginate && (
        <div className="flex flex-col gap-3 border-t border-[var(--border)] px-4 py-3 text-xs text-[var(--text-muted)] md:flex-row md:items-center md:justify-between">
          <span>
            Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount() || 1}
            {" · "}
            {table.getRowCount()} row{table.getRowCount() === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1">
              <span>Rows</span>
              <select
                value={table.getState().pagination.pageSize}
                onChange={(e) => table.setPageSize(Number(e.target.value))}
                className="rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5"
              >
                {pageSizeOptions.map((sz) => (
                  <option key={sz} value={sz}>{sz}</option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Previous page"
                disabled={!table.getCanPreviousPage()}
                onClick={() => table.previousPage()}
                className="rounded p-1 enabled:hover:bg-[var(--primary-tint)] disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label="Next page"
                disabled={!table.getCanNextPage()}
                onClick={() => table.nextPage()}
                className="rounded p-1 enabled:hover:bg-[var(--primary-tint)] disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
