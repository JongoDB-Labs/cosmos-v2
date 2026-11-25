"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatDrawerTarget } from "@/lib/chat/drawer-link";

/**
 * The set of global DOCKED drawers. Unlike a modal sheet, these are NON-MODAL:
 * no backdrop, no blur, no focus trap — they dock on the right and the main
 * content reflows beside them, so the drawer is a true side-by-side
 * multitasking tool (take notes while watching the kanban board, chat with
 * someone while viewing a page, etc.). Only one is open at a time.
 */
/**
 * Context handed to a panel by whoever opened it — the product tour naming the
 * step somebody is looking at, or a chat link naming a conversation. Panels
 * that do not understand a seed ignore it, and it is cleared on the next open
 * so it can never outlive the intent that set it.
 */
export interface DrawerSeed {
  /** Prefills a title where the panel has one. */
  title?: string;
  /** Prefills a body where the panel has one. */
  body?: string;
  /** Free-form origin, e.g. "tour:2.361.0:runway", for attribution. */
  source?: string;
  /** The conversation the Chat panel opens on (see `lib/chat/drawer-link`). */
  chat?: ChatDrawerTarget;
}

export type DrawerTool =
  | "assistant"
  | "chat"
  | "notes"
  | "feedback"
  | "meetings";

const WIDTH_KEY = "cosmos:drawer-width";
/**
 * Which tool is minimized to the side tab, if any: `{"tool":"assistant"}`.
 * Only this is remembered across a reload; an open drawer still starts closed.
 */
export const MINIMIZED_KEY = "cosmos:drawer-minimized";
export const DRAWER_TOOLS: readonly DrawerTool[] = [
  "assistant",
  "chat",
  "notes",
  "feedback",
  "meetings",
];

function writeMinimized(tool: DrawerTool | null) {
  try {
    if (tool) window.localStorage.setItem(MINIMIZED_KEY, JSON.stringify({ tool }));
    else window.localStorage.removeItem(MINIMIZED_KEY);
  } catch {
    /* localStorage unavailable */
  }
}

function readMinimized(): DrawerTool | null {
  try {
    const raw = window.localStorage.getItem(MINIMIZED_KEY);
    if (!raw) return null;
    const tool = (JSON.parse(raw) as { tool?: unknown })?.tool;
    if (typeof tool === "string" && (DRAWER_TOOLS as readonly string[]).includes(tool)) {
      return tool as DrawerTool;
    }
    window.localStorage.removeItem(MINIMIZED_KEY);
  } catch {
    try {
      window.localStorage.removeItem(MINIMIZED_KEY);
    } catch {
      /* localStorage unavailable */
    }
  }
  return null;
}
export const DRAWER_MIN_WIDTH = 320;
export const DRAWER_MAX_WIDTH = 900;
const DRAWER_DEFAULT_WIDTH = 460;

function clampWidth(n: number): number {
  return Math.max(DRAWER_MIN_WIDTH, Math.min(DRAWER_MAX_WIDTH, Math.round(n)));
}

interface DrawerContextValue {
  /** The selected tool (open or minimized), or null when closed. */
  tool: DrawerTool | null;
  /** True while the selected tool is put aside to the side tab. */
  minimized: boolean;
  /** A tool is selected and NOT minimized: the drawer is on screen. */
  isShown: boolean;
  /** Put the drawer aside to the side tab (the assistant when none is selected). */
  minimize: () => void;
  /** Bring a minimized drawer back. */
  restore: () => void;
  /** What the opener wanted this panel to start from; null when opened by hand. */
  seed: DrawerSeed | null;
  /** Open (or switch to) a tool, optionally seeding the panel. */
  open: (tool: DrawerTool, seed?: DrawerSeed) => void;
  /** Back-compat alias for `open`. */
  openDrawer: (tool: DrawerTool, seed?: DrawerSeed) => void;
  /**
   * Toggle a tool — opens it, or closes if it's already the open one. A
   * minimized tool is restored rather than closed.
   */
  toggle: (tool: DrawerTool) => void;
  close: () => void;
  /** This tool is the selected one (open or minimized). */
  isOpen: (tool: DrawerTool) => boolean;
  /** Current docked width in px (persisted). */
  width: number;
  setWidth: (n: number) => void;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);

export function DrawerProvider({ children }: { children: React.ReactNode }) {
  // One object, so restoring the remembered minimized state can be a single
  // functional update that sees an open() made in the same commit.
  const [state, setState] = useState<{
    tool: DrawerTool | null;
    minimized: boolean;
    seed: DrawerSeed | null;
  }>({ tool: null, minimized: false, seed: null });
  const { tool, minimized, seed } = state;
  const [width, setWidthState] = useState<number>(DRAWER_DEFAULT_WIDTH);

  // Restore the persisted width on mount (client-only → no hydration mismatch).
  useEffect(() => {
    if (typeof window === "undefined") return;
    let saved = NaN;
    try {
      saved = Number(window.localStorage.getItem(WIDTH_KEY));
    } catch {
      /* localStorage unavailable */
    }
    // One-shot restore of the persisted width after mount; the default ships in
    // the server render so there's no hydration mismatch (the drawer is closed
    // initially, so nothing width-dependent is in the DOM yet).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (Number.isFinite(saved) && saved > 0) setWidthState(clampWidth(saved));
  }, []);

  // Restore a remembered minimized tab once after mount (the server renders
  // "not minimized", like the width). Something that already opened a drawer
  // in this commit — a chat link — wins over the stored state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = readMinimized();
    if (!stored) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((s) => (s.tool === null ? { ...s, tool: stored, minimized: true } : s));
  }, []);

  // Write the remembered state whenever it changes. Skipped for the very first
  // render so the initial "nothing selected" does not erase the stored tab
  // before the restore above has read it.
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    writeMinimized(minimized ? tool : null);
  }, [tool, minimized]);

  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /**
   * The width is applied immediately; PERSISTING it is debounced.
   *
   * This is called on every `pointermove` of a resize drag — 60-120 times a
   * second — and `localStorage.setItem` is synchronous main-thread work. Writing
   * on each call put a disk write in the middle of a drag's hot path, so a drag
   * that failed to end (see DockedDrawer's resize handler) kept writing for as
   * long as the pointer moved, which is how a stuck drag went from "the edge
   * follows my mouse" to a tab that stopped painting.
   *
   * Debouncing changes nothing a caller can observe: `width` still updates
   * synchronously, and the stored value is the last one within ~200ms. The
   * Expand/Shrink buttons persist just as well, a touch later.
   */
  const setWidth = useCallback((n: number) => {
    const w = clampWidth(n);
    setWidthState(w);
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      try {
        window.localStorage.setItem(WIDTH_KEY, String(w));
      } catch {
        /* localStorage unavailable */
      }
    }, 200);
  }, []);

  // Don't leave a pending write behind on unmount.
  useEffect(() => () => clearTimeout(persistTimer.current), []);

  const open = useCallback((t: DrawerTool, s?: DrawerSeed) => {
    // Always written, including to null: a stale seed reappearing the next time
    // somebody opens the drawer by hand would put words in their mouth.
    setState({ tool: t, minimized: false, seed: s ?? null });
  }, []);
  const close = useCallback(() => {
    setState({ tool: null, minimized: false, seed: null });
  }, []);
  const minimize = useCallback(() => {
    setState((cur) => ({ ...cur, tool: cur.tool ?? "assistant", minimized: true }));
  }, []);
  const restore = useCallback(() => {
    setState((cur) => (cur.tool ? { ...cur, minimized: false } : cur));
  }, []);
  const toggle = useCallback((t: DrawerTool) => {
    setState((cur) => {
      if (cur.tool === t && cur.minimized) return { ...cur, minimized: false };
      if (cur.tool === t) return { tool: null, minimized: false, seed: null };
      return { tool: t, minimized: false, seed: null };
    });
  }, []);
  const isOpen = useCallback((t: DrawerTool) => tool === t, [tool]);
  const isShown = tool !== null && !minimized;

  const value = useMemo<DrawerContextValue>(
    () => ({
      tool,
      minimized,
      isShown,
      minimize,
      restore,
      seed,
      open,
      openDrawer: open,
      toggle,
      close,
      isOpen,
      width,
      setWidth,
    }),
    [tool, minimized, isShown, minimize, restore, seed, open, toggle, close, isOpen, width, setWidth],
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
      minimized: false,
      isShown: false,
      minimize: () => {},
      restore: () => {},
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
