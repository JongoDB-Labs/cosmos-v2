"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { Tour } from "@/lib/tours/types";

const PROGRESS_KEY = "cosmos:tour-progress";

interface TourContextValue {
  tour: Tour | null;
  index: number;
  start: (tour: Tour, at?: number) => void;
  next: () => void;
  back: () => void;
  goTo: (i: number) => void;
  stop: () => void;
}

const TourContext = createContext<TourContextValue | null>(null);

/** Where this browser left off in a given tour, or 0. */
function readProgress(version: string): number {
  if (typeof window === "undefined") return 0;
  try {
    const raw = window.localStorage.getItem(PROGRESS_KEY);
    if (!raw) return 0;
    const map = JSON.parse(raw) as Record<string, number>;
    const n = map[version];
    return typeof n === "number" && n >= 0 ? n : 0;
  } catch {
    // A private window, cleared storage, or a value some earlier version wrote
    // in a different shape. Starting from the beginning is a fine answer; losing
    // the page to a parse error is not.
    return 0;
  }
}

function writeProgress(version: string, index: number) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(PROGRESS_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    map[version] = index;
    window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
  } catch {
    /* progress is a convenience, never a requirement */
  }
}

export function TourProvider({ children }: { children: React.ReactNode }) {
  const [tour, setTour] = useState<Tour | null>(null);
  const [index, setIndex] = useState(0);

  const start = useCallback((t: Tour, at?: number) => {
    // Resume where they stopped unless the caller names a step. Somebody
    // returning to a tour they abandoned halfway does not want to start again.
    const from = typeof at === "number" ? at : readProgress(t.version);
    setIndex(Math.min(Math.max(0, from), Math.max(0, t.steps.length - 1)));
    setTour(t);
  }, []);

  const goTo = useCallback(
    (i: number) => {
      setTour((cur) => {
        if (!cur) return cur;
        const clamped = Math.min(Math.max(0, i), cur.steps.length - 1);
        setIndex(clamped);
        writeProgress(cur.version, clamped);
        return cur;
      });
    },
    [],
  );

  const next = useCallback(() => {
    setTour((cur) => {
      if (!cur) return cur;
      setIndex((i) => {
        const n = Math.min(i + 1, cur.steps.length - 1);
        writeProgress(cur.version, n);
        return n;
      });
      return cur;
    });
  }, []);

  const back = useCallback(() => {
    setTour((cur) => {
      if (!cur) return cur;
      setIndex((i) => {
        const n = Math.max(i - 1, 0);
        writeProgress(cur.version, n);
        return n;
      });
      return cur;
    });
  }, []);

  const stop = useCallback(() => setTour(null), []);

  const value = useMemo<TourContextValue>(
    () => ({ tour, index, start, next, back, goTo, stop }),
    [tour, index, start, next, back, goTo, stop],
  );

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

/**
 * No-op outside a provider rather than a throw: the tour is an optional
 * flourish, and a surface that forgets to mount the provider should render
 * without a tour, not fail to render.
 */
export function useTour(): TourContextValue {
  return (
    useContext(TourContext) ?? {
      tour: null,
      index: 0,
      start: () => {},
      next: () => {},
      back: () => {},
      goTo: () => {},
      stop: () => {},
    }
  );
}
