"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Z_ASSISTANT } from "@/lib/ui/layers";

/** The side tab's id, so a control that minimizes can move focus onto it. */
export const DRAWER_TAB_ID = "cosmos-drawer-tab";
/** Width the desktop rail reserves at the right edge (the page reflows beside it). */
export const DRAWER_TAB_WIDTH = 40;

/** Move focus onto the side tab once a minimize has committed. */
export function focusDrawerTab() {
  requestAnimationFrame(() => document.getElementById(DRAWER_TAB_ID)?.focus());
}

/**
 * A minimized drawer, put aside to the right edge.
 *
 * Desktop: a full-height 40px rail; the shell reserves its width through
 * `--cosmos-drawer-w`, so nothing on the page is ever underneath it and the
 * page's lower-right corner stays reachable. Phones: a small tab, vertically
 * centred on the right edge, clear of the bottom nav (no room to reflow).
 */
export function DrawerTab({
  label,
  icon: Icon,
  controls,
  onRestore,
  isDesktop,
}: {
  label: string;
  icon: LucideIcon;
  /** The (hidden) drawer's id. */
  controls: string;
  onRestore: () => void;
  isDesktop: boolean;
}) {
  return (
    <div
      className={cn(
        "fixed right-0",
        Z_ASSISTANT,
        isDesktop
          ? "top-0 bottom-0 flex w-10 flex-col items-center border-l border-[var(--border)] bg-[var(--surface)] pt-14"
          : "top-1/2 -translate-y-1/2",
      )}
    >
      <button
        id={DRAWER_TAB_ID}
        type="button"
        onClick={onRestore}
        aria-label={`Restore ${label}`}
        aria-expanded="false"
        aria-controls={controls}
        title={`Restore ${label}`}
        className={cn(
          "flex flex-col items-center gap-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]",
          isDesktop
            ? "w-8 rounded-md py-3 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]"
            : "h-24 w-10 justify-center rounded-l-lg bg-[var(--primary)] text-[var(--primary-foreground)] shadow-lg",
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {isDesktop && (
          <span className="[writing-mode:vertical-rl] whitespace-nowrap">{label}</span>
        )}
      </button>
    </div>
  );
}
