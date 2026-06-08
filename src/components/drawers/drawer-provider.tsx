"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

/**
 * The set of global slide-over drawers. These OVERLAY the current screen
 * (board, list, …) so the user can chat with the assistant, jot a note, or
 * file feedback without leaving their work — mirroring the okr-dashboard UX.
 */
export type DrawerId = "assistant" | "notes" | "feedback";

interface DrawerContextValue {
  /** The currently open drawer, or null when all are closed. */
  open: DrawerId | null;
  /** Open a specific drawer (replaces any currently-open one). */
  openDrawer: (id: DrawerId) => void;
  /** Close whatever drawer is open. */
  close: () => void;
  /** True when the given drawer is the open one. */
  isOpen: (id: DrawerId) => boolean;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);

/**
 * Mounted once in the dashboard shell. Exposes a tiny store so any client
 * surface (topbar icon buttons, command palette, mobile nav) can drive the
 * global drawers via `openDrawer(...)` / `close()`.
 *
 * Only one drawer is open at a time — opening another swaps it, which keeps
 * the overlay model simple and avoids stacking sheets.
 */
export function DrawerProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState<DrawerId | null>(null);

  const openDrawer = useCallback((id: DrawerId) => setOpen(id), []);
  const close = useCallback(() => setOpen(null), []);
  const isOpen = useCallback((id: DrawerId) => open === id, [open]);

  const value = useMemo<DrawerContextValue>(
    () => ({ open, openDrawer, close, isOpen }),
    [open, openDrawer, close, isOpen],
  );

  return (
    <DrawerContext.Provider value={value}>{children}</DrawerContext.Provider>
  );
}

/**
 * Access the global drawer store. Returns a no-op fallback when used outside a
 * provider so a stray render (e.g. on a non-dashboard route) never throws.
 */
export function useDrawers(): DrawerContextValue {
  const ctx = useContext(DrawerContext);
  if (!ctx) {
    return {
      open: null,
      openDrawer: () => {},
      close: () => {},
      isOpen: () => false,
    };
  }
  return ctx;
}
