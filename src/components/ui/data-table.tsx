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
import { Fragment, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "./checkbox";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "./dropdown-menu";
import { guardScroll, type ActionMenuGroup } from "./action-menu";

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
  /** When provided, every row supports RIGHT-CLICK (a context menu opens at the
   * cursor) AND gets a trailing ⋯ actions column (for touch / discoverability).
   * Both render the same menu. Return [] for a row to give it no actions. */
  rowActions?: (row: T) => ActionMenuGroup[];
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
  rowActions,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);

  // Shared row context menu (right-click anywhere on a row + the ⋯ column).
  // Reuses ActionMenu's trick: position one hidden DropdownMenu trigger at the
  // cursor, click it, reset — so a single menu serves every row.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuGroups, setMenuGroups] = useState<ActionMenuGroup[]>([]);
  const ctxBtnRef = useRef<HTMLButtonElement>(null);
  // Park the (1px, invisible) anchor at a FIXED in-viewport spot when idle
  // instead of returning it to document flow. base-ui restores focus to this
  // anchor when the menu closes; if it sat in a scrolled row, the browser would
  // scroll it into view (the table "jerks down" on close). Pinned fixed at 0,0
  // it's always in view, so the focus-restore can't scroll anything.
  const resetCtxBtn = () => {
    const btn = ctxBtnRef.current;
    if (btn) {
      Object.assign(btn.style, {
        position: "fixed",
        left: "0px",
        top: "0px",
        width: "1px",
        height: "1px",
        padding: "0",
        overflow: "hidden",
        pointerEvents: "none",
      });
    }
  };
  const openRowMenu = (x: number, y: number, groups: ActionMenuGroup[]) => {
    if (groups.every((g) => g.items.length === 0)) return;
    setMenuGroups(groups);
    const btn = ctxBtnRef.current;
    if (!btn) return;
    // Neutralize the focus-into-view scroll the menu triggers (the hidden anchor
    // sits in a scrolled row) — without this the table "jerks" on right-click.
    guardScroll(btn.parentElement);
    // Pin the (1px, invisible) anchor at the cursor and KEEP it there while the
    // menu is open — base-ui auto-positions the popup to the live anchor rect,
    // so resetting too early made the menu jump to the trigger's natural
    // (top-left) spot instead of following the click. Reset on close instead.
    Object.assign(btn.style, {
      position: "fixed",
      left: `${x}px`,
      top: `${y}px`,
      width: "1px",
      height: "1px",
      padding: "0",
      overflow: "hidden",
      pointerEvents: "none",
    });
    btn.click();
  };
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const paginationObj = typeof pagination === "object" ? pagination : null;
  const [paginationState, setPaginationState] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: initialPageSize ?? paginationObj?.pageSize ?? 20,
  });

  const pageSizeOptions = paginationObj?.pageSizeOptions ?? [10, 20, 50, 100];
  const paginate = Boolean(pagination);

  // Shift-click range selection. `lastSelectedRef` is the anchor (last checkbox
  // clicked). A checkbox click fires onClick THEN its own onChange; the onChange
  // toggles a single row off STALE selection state and would clobber a range we
  // set in onClick — so onClick raises `suppressToggleRef` to make the very next
  // onChange a no-op. (preventDefault on the click does NOT stop that onChange.)
  const lastSelectedRef = useRef<string | null>(null);
  const suppressToggleRef = useRef(false);

  const columnsWithSelection = useMemo<ColumnDef<T>[]>(() => {
    let cols = columns;
    if (rowSelection !== undefined) {
      const selectionCol: ColumnDef<T> = {
        id: "__select",
        size: 36,
        enableSorting: false,
        enableGrouping: false,
        header: ({ table }) => {
          // Select-all spans the WHOLE filtered result set, not just the visible
          // page (BR f6b52435: bulk delete was silently missing rows on other
          // pages). Built from the filtered row model explicitly so the scope is
          // unambiguous: everything matching the current search/filters.
          const selectable = table
            .getFilteredRowModel()
            .rows.filter((r) => r.getCanSelect());
          const allSelected =
            selectable.length > 0 && selectable.every((r) => r.getIsSelected());
          const someSelected = selectable.some((r) => r.getIsSelected());
          return (
            <Checkbox
              checked={allSelected}
              indeterminate={!allSelected && someSelected}
              onChange={(e) => {
                const next: RowSelectionState = {};
                if (e.target.checked) {
                  for (const r of selectable) next[r.id] = true;
                }
                table.setRowSelection(next);
              }}
              aria-label={`Select all ${selectable.length} rows`}
            />
          );
        },
        cell: ({ row, table }) => (
          // Stop the click bubbling to the row's onClick — otherwise ticking a
          // checkbox to bulk-select also opens the detail drawer (FR/BR).
          <div
            onClick={(e) => {
              e.stopPropagation();
              // Shift-click selects the contiguous range between the last-clicked
              // row and this one (in the current sorted/filtered order), like a
              // file list. A plain click just toggles + re-anchors (handled by the
              // checkbox's onChange below).
              const anchor = lastSelectedRef.current;
              if (e.shiftKey && anchor && anchor !== row.id && onRowSelectionChange) {
                const rows = table.getRowModel().rows;
                const from = rows.findIndex((r) => r.id === anchor);
                const to = rows.findIndex((r) => r.id === row.id);
                if (from !== -1 && to !== -1) {
                  const [a, b] = from < to ? [from, to] : [to, from];
                  const next: RowSelectionState = { ...(rowSelection ?? {}) };
                  for (let i = a; i <= b; i++) {
                    if (rows[i].getCanSelect()) next[rows[i].id] = true;
                  }
                  onRowSelectionChange(next);
                  // The checkbox's onChange fires right after this and would toggle
                  // just this row off stale state, clobbering the range — skip it.
                  suppressToggleRef.current = true;
                }
              }
              lastSelectedRef.current = row.id;
            }}
          >
            <Checkbox
              checked={row.getIsSelected()}
              disabled={!row.getCanSelect()}
              onChange={(e) => {
                if (suppressToggleRef.current) {
                  suppressToggleRef.current = false;
                  return;
                }
                row.toggleSelected(e.target.checked);
              }}
              aria-label="Select row"
            />
          </div>
        ),
      };
      cols = [selectionCol, ...cols];
    }
    if (rowActions) {
      const actionsCol: ColumnDef<T> = {
        id: "__actions",
        size: 40,
        enableSorting: false,
        enableGrouping: false,
        header: "",
        cell: ({ row }) => (
          <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              aria-label="Row actions"
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                openRowMenu(r.right, r.bottom, rowActions(row.original));
              }}
              className="rounded-md p-1 text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-[var(--primary-tint)] hover:text-[var(--text)] focus:opacity-100 group-hover:opacity-100"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </div>
        ),
      };
      cols = [...cols, actionsCol];
    }
    return cols;
    // openRowMenu is stable across renders (refs/setState); excluded to keep the
    // memo from rebuilding the columns every render.

  }, [columns, rowSelection, rowActions, onRowSelectionChange]);

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
    <>
    {rowActions && (
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(o) => {
          setMenuOpen(o);
          if (!o) {
            resetCtxBtn();
            // Focus returns to the hidden anchor on close — guard the scroll for
            // a longer window since the focus-restore fires after the close
            // animation (~quarter-second) rather than immediately.
            guardScroll(ctxBtnRef.current?.parentElement ?? null, 45);
          }
        }}
      >
        <DropdownMenuTrigger
          render={
            <button
              ref={ctxBtnRef}
              type="button"
              aria-hidden
              tabIndex={-1}
              // Start parked fixed in-viewport (see resetCtxBtn) so focus-restore
              // on close never scrolls the table.
              style={{ position: "fixed", left: 0, top: 0, width: 1, height: 1, pointerEvents: "none" }}
              className="opacity-0"
            />
          }
        />
        {/* positionMethod="fixed" mirrors base-ui's own ContextMenu: a fixed
            popup has no scrollable ancestor, so focusing a menu item on open
            can't scroll the table into view — half of the right-click "jerk"
            fix (COSMOS-36); the other half is the fixed-parked anchor + the
            capture-phase guardScroll on open/close. */}
        <DropdownMenuContent align="start" side="bottom" sideOffset={2} positionMethod="fixed" className="min-w-[160px]">
          {menuGroups
            .filter((group) => group.items.length > 0)
            .map((group, gi) => (
              // base-ui's Menu.GroupLabel requires a Menu.Group ancestor — a
              // bare label throws production error #31 on menu open. Wrap each
              // group in DropdownMenuGroup (also restores group a11y semantics).
              // Index the FILTERED list so an empty leading group leaves no
              // stray separator. Mirrors the action-menu.tsx fix.
              <DropdownMenuGroup key={group.label ?? gi}>
                {gi > 0 && <DropdownMenuSeparator />}
                {group.label && <DropdownMenuLabel>{group.label}</DropdownMenuLabel>}
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <DropdownMenuItem
                      key={item.label}
                      variant={item.variant}
                      disabled={item.disabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        item.onClick();
                        setMenuOpen(false);
                      }}
                    >
                      {Icon && <Icon className="h-4 w-4" />}
                      {item.label}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )}
    <div className="overflow-x-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
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
                  onContextMenu={
                    rowActions
                      ? (e) => {
                          e.preventDefault();
                          openRowMenu(
                            e.clientX,
                            e.clientY,
                            rowActions(row.original),
                          );
                        }
                      : undefined
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
                    // Control columns (selection checkbox, ⋯ actions) must never
                    // open the row's detail drawer. Their inner controls already
                    // stopPropagation, but the cell padding around a small control
                    // is a dead zone that would otherwise bubble a click up to the
                    // row's onClick — so swallow clicks for the WHOLE cell.
                    // (COSMOS-26: ticking a bulk-select checkbox popped the drawer,
                    // because the click landed in that padding, not on the input.)
                    const isControlCell =
                      cell.column.id === "__select" ||
                      cell.column.id === "__actions";
                    return (
                      <td
                        key={cell.id}
                        data-label={headerText}
                        onClick={
                          isControlCell ? (e) => e.stopPropagation() : undefined
                        }
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
    </>
  );
}
