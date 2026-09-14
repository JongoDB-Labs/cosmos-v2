"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * The set of global DOCKED drawers. Unlike a modal sheet, these are NON-MODAL:
 * no backdrop, no blur, no focus trap — they dock on the right and the main
 * content reflows beside them, so the drawer is a true side-by-side
 * multitasking tool (take notes while watching the kanban board, chat with
 * someone while viewing a page, etc.). Only one is open at a time.
 */
/**
 * Context handed to a panel by whoever opened it — today, the product tour
 * naming the step somebody is looking at. Panels that do not understand a seed
 * ignore it, and it is cleared on the next open so it can never outlive the
 * intent that set it.
 */
export interface DrawerSeed {
  /** Prefills a title where the panel has one. */
  title?: string;
  /** Prefills a body where the panel has one. */
  body?: string;
  /** Free-form origin, e.g. "tour:2.361.0:runway", for attribution. */
  source?: string;
}

export type DrawerTool =
  | "assistant"
  | "chat"
  | "notes"
  | "feedback"
  | "meetings";

const WIDTH_KEY = "cosmos:drawer-width";
export const DRAWER_MIN_WIDTH = 320;
export const DRAWER_MAX_WIDTH = 900;
const DRAWER_DEFAULT_WIDTH = 460;

function clampWidth(n: number): number {
  return Math.max(DRAWER_MIN_WIDTH, Math.min(DRAWER_MAX_WIDTH, Math.round(n)));
}

interface DrawerContextValue {
  /** The currently open tool, or null when closed. */
  tool: DrawerTool | null;
  /** What the opener wanted this panel to start from; null when opened by hand. */
  seed: DrawerSeed | null;
  /** Open (or switch to) a tool, optionally seeding the panel. */
  open: (tool: DrawerTool, seed?: DrawerSeed) => void;
  /** Back-compat alias for `open`. */
  openDrawer: (tool: DrawerTool, seed?: DrawerSeed) => void;
  /** Toggle a tool — opens it, or closes if it's already the open one. */
  toggle: (tool: DrawerTool) => void;
  close: () => void;
  isOpen: (tool: DrawerTool) => boolean;
  /** Current docked width in px (persisted). */
  width: number;
  setWidth: (n: number) => void;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);

export function DrawerProvider({ children }: { children: React.ReactNode }) {
  const [tool, setTool] = useState<DrawerTool | null>(null);
  const [seed, setSeed] = useState<DrawerSeed | null>(null);
  const [width, setWidthState] = useState<number>(DRAWER_DEFAULT_WIDTH);

  // Restore the persisted width on mount (client-only → no hydration mismatch).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = Number(window.localStorage.getItem(WIDTH_KEY));
    // One-shot restore of the persisted width after mount; the default ships in
    // the server render so there's no hydration mismatch (the drawer is closed
    // initially, so nothing width-dependent is in the DOM yet).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (Number.isFinite(saved) && saved > 0) setWidthState(clampWidth(saved));
  }, []);

  const setWidth = useCallback((n: number) => {
    const w = clampWidth(n);
    setWidthState(w);
    try {
      window.localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  const open = useCallback((t: DrawerTool, s?: DrawerSeed) => {
    // Always written, including to null: a stale seed reappearing the next time
    // somebody opens the drawer by hand would put words in their mouth.
    setSeed(s ?? null);
    setTool(t);
  }, []);
  const close = useCallback(() => {
    setSeed(null);
    setTool(null);
  }, []);
  const toggle = useCallback(
    (t: DrawerTool) => {
      setSeed(null);
      setTool((cur) => (cur === t ? null : t));
    },
    [],
  );
  const isOpen = useCallback((t: DrawerTool) => tool === t, [tool]);

  const value = useMemo<DrawerContextValue>(
    () => ({
      tool,
      seed,
      open,
      openDrawer: open,
      toggle,
      close,
      isOpen,
      width,
      setWidth,
    }),
    [tool, seed, open, toggle, close, isOpen, width, setWidth],
  );

  return (
    <DrawerContext.Provider value={value}>{children}</DrawerContext.Provider>
  );
}

/** No-op fallback outside a provider so a stray render never throws. */
export function useDrawers(): DrawerContextValue {
  const ctx = useContext(DrawerContext);
  if (!ctx) {
    return {
      tool: null,
      open: () => {},
      seed: null,
      openDrawer: () => {},
      toggle: () => {},
      close: () => {},
      isOpen: () => false,
      width: DRAWER_DEFAULT_WIDTH,
      setWidth: () => {},
    };
  }
  return ctx;
}
