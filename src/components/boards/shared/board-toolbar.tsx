"use client";

import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The band a board's toolbar is, and the groups inside it.
 *
 * Every board type used to hand-write this. Eleven implementations drifted to
 * four band heights (py-1.5, py-2, py-2.5, py-3), two gaps, three background
 * treatments, and -- the visible one -- three "Hide done" checkboxes of which
 * two looked alike and one did not. See `board-toolbar.test.tsx`.
 *
 * The contract is a reading order, not a style: the LEFT of the band says what
 * this board is and how much is on it, and {@link BoardToolbarActions} on the
 * right says what you can do with it, with the primary action last. That is
 * the split the Issues page already enforces by test, and the reason "New
 * issue" is now in the same place on every board.
 *
 * It sits BELOW the filter surface, which owns its own band -- see
 * `chrome-bands.arch.test.ts`, and do not wrap either of them in another one.
 */

/**
 * The one spelling of this label.
 *
 * Timeline shows Hide-done as a toggle BUTTON inside its captioned "Lenses"
 * group rather than as a checkbox, which is a deliberate and coherent local
 * idiom -- forcing it into a checkbox would be consistency against the grain.
 * It shares the wording instead, so the two cannot drift apart.
 */
export const HIDE_DONE_LABEL = "Hide done";

/** The band's own classes. Exported so a board can assert against it, never to be overridden piecemeal. */
export const BOARD_TOOLBAR_BAND =
  "flex flex-wrap items-center gap-3 border-b border-[var(--border)] bg-background/50 px-4 py-2 text-sm";

export function BoardToolbar({
  children,
  className,
}: {
  children: ReactNode;
  /** For a board that must add a layout property (`shrink-0`), never padding or borders. */
  className?: string;
}) {
  return <div className={cn(BOARD_TOOLBAR_BAND, className)}>{children}</div>;
}

/**
 * The right-hand group. Put view toggles first and the primary action last, so
 * the create control is the band's right edge on every board.
 */
export function BoardToolbarActions({ children }: { children: ReactNode }) {
  return <div className="ml-auto flex flex-wrap items-center gap-3">{children}</div>;
}

/** Identity: the board's own name, with its icon. */
export function BoardToolbarTitle({
  icon: Icon,
  children,
}: {
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 font-medium text-[var(--text)]">
      {Icon ? <Icon className="size-4 text-[var(--primary)]" aria-hidden /> : null}
      {children}
    </div>
  );
}

/** How much is on the board — a count, a total, a summary. Muted, next to the title. */
export function BoardToolbarMeta({ children }: { children: ReactNode }) {
  return <span className="text-xs text-[var(--text-muted)]">{children}</span>;
}

/**
 * A labelled checkbox in a board's toolbar.
 *
 * There were two of these by accident. Backlog and RAID drew a 14px bordered,
 * rounded box at text-xs; Roadmap's Hide-done and the release timeline's level
 * filters passed only `accent-[var(--primary)]`, so the box was whatever the
 * browser drew at the surrounding font size -- visibly larger, square, and
 * unbordered. Same control, two appearances, on boards one click apart.
 *
 * `onChange` takes the new boolean rather than the event, so a caller cannot
 * read the wrong field off it.
 */
export function BoardToggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-muted)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-[var(--border)] accent-[var(--primary)]"
      />
      {children}
    </label>
  );
}

/**
 * "Hide done", once. The state stays with the board -- it is that board's view
 * state, and sharing it across boards would be wrong -- but the control is one
 * thing, and so is the wording.
 */
export function HideDoneToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (hideDone: boolean) => void;
}) {
  return (
    <BoardToggle checked={checked} onChange={onChange}>
      {HIDE_DONE_LABEL}
    </BoardToggle>
  );
}
