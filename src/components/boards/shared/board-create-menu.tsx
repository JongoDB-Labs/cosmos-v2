"use client";

import { useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";
import { ActionRow, guardScroll } from "@/components/ui/action-menu";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import type { NewIssueSeed } from "@/components/boards/shared/new-issue-button";

/** A right-click inside an element carrying one of these creates into it:
 *  a Status column (`data-board-column="<key>"`) or a calendar day
 *  (`data-board-date="YYYY-MM-DD"`). */
const COLUMN_ATTR = "data-board-column";
const DATE_ATTR = "data-board-date";

interface CreateTarget {
  seed: NewIssueSeed;
  label: string;
}

function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Where a board right-click should create, or `undefined` to leave the event
 * alone (the browser's own menu then shows).
 *
 * Steps aside when something closer already handled the right-click (cards,
 * rows and Gantt bars all `preventDefault` for their own menus), and over
 * editable fields and links, where the native menu (paste, open in new tab)
 * is what the user wants.
 */
export function boardCreateTarget(
  e: Pick<ReactMouseEvent, "defaultPrevented" | "target">,
  columns: readonly { key: string; name: string }[] = [],
): CreateTarget | undefined {
  if (e.defaultPrevented) return undefined;
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest("input, textarea, select, a[href], [contenteditable='true']")) {
    return undefined;
  }
  const date = el?.closest(`[${DATE_ATTR}]`)?.getAttribute(DATE_ATTR);
  if (date) return { seed: { date }, label: `New issue on ${dayLabel(date)}` };
  const key = el?.closest(`[${COLUMN_ATTR}]`)?.getAttribute(COLUMN_ATTR);
  const column = key ? columns.find((c) => c.key === key) : undefined;
  if (column) return { seed: { columnKey: column.key }, label: `New issue in ${column.name}` };
  return { seed: {}, label: "New issue" };
}

/**
 * COSMOS-88: right-click empty space on a board to create the board's item.
 *
 * Wraps the board's surface. A right-click on empty space opens a one-row menu
 * at the cursor: "New issue", or "New issue in <column>" / "New issue on
 * <day>" over a marked column or calendar day. Choosing it calls `onCreate`,
 * which every board wires to its own `NewIssueButton`, so this is the same
 * create dialog and the same defaults as the toolbar button, pre-scoped by the
 * seed. Hidden-anchor positioning mirrors `data-table.tsx`'s row menu.
 */
export function BoardCreateMenu({
  onCreate,
  columns,
  disabled = false,
  children,
}: {
  onCreate: (seed: NewIssueSeed) => void;
  /** The board's columns, so a right-clicked column can be named in the menu. */
  columns?: readonly { key: string; name: string }[];
  /** Off while the board is in a mode that hides "New issue" (bulk select). */
  disabled?: boolean;
  children: ReactNode;
}) {
  const { can } = usePermissions();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<CreateTarget>({ seed: {}, label: "New issue" });
  const anchorRef = useRef<HTMLButtonElement>(null);

  // The create API is ITEM_CREATE-gated: without it, keep the browser's menu
  // rather than offer an action that can only fail.
  const enabled = !disabled && can(Permission.ITEM_CREATE);

  const parkAnchor = (x = 0, y = 0) => {
    const btn = anchorRef.current;
    if (!btn) return;
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
  };

  const handleContextMenu = (e: ReactMouseEvent) => {
    if (!enabled) return;
    const next = boardCreateTarget(e, columns);
    if (!next) return;
    e.preventDefault();
    setTarget(next);
    const btn = anchorRef.current;
    if (!btn) return;
    // Same anti-"jerk" treatment as the table's row menu (COSMOS-36): keep the
    // anchor pinned at the cursor while open and guard the focus scroll.
    guardScroll(btn.parentElement);
    parkAnchor(e.clientX, e.clientY);
    btn.click();
  };

  if (!enabled) return <>{children}</>;

  return (
    <div onContextMenu={handleContextMenu} className="contents">
      {children}
      <DropdownMenu
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            parkAnchor();
            guardScroll(anchorRef.current?.parentElement ?? null, 45);
          }
        }}
      >
        <DropdownMenuTrigger
          render={
            <button
              ref={anchorRef}
              type="button"
              aria-hidden
              tabIndex={-1}
              style={{ position: "fixed", left: 0, top: 0, width: 1, height: 1, pointerEvents: "none" }}
              className="opacity-0"
            />
          }
        />
        <DropdownMenuContent
          align="start"
          side="bottom"
          sideOffset={2}
          positionMethod="fixed"
          // Size to the label: the 1px anchor would otherwise cap the width and
          // truncate "New issue in <column>".
          className="w-max min-w-[160px] max-w-80"
        >
          <ActionRow
            item={{
              label: target.label,
              icon: Plus,
              onClick: () => onCreate(target.seed),
            }}
            onDone={() => setOpen(false)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
