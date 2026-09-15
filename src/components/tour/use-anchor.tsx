"use client";

import { useEffect, useState } from "react";

export interface AnchorBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Find the element a step points at, and follow it.
 *
 * Matched on [data-tour="…"] rather than a CSS selector into somebody else's
 * markup: a selector stops matching the first time that component is restyled,
 * silently, and a walkthrough that highlights the wrong thing is worse than one
 * that highlights nothing.
 *
 * Returns null until the element exists — pages load their data after mount, so
 * the thing a step is about is routinely absent for the first second — and
 * again if it disappears. Callers fall back to a corner rather than pointing at
 * empty space.
 *
 * Tracks scroll and resize because the reader is expected to look around; a
 * highlight pinned to where the element WAS is just a box in the wrong place.
 */
export function useAnchor(anchor: string | undefined): AnchorBox | null {
  const [box, setBox] = useState<AnchorBox | null>(null);

  useEffect(() => {
    let raf = 0;

    const measure = () => {
      // Every write to state happens here, inside the frame callback, rather
      // than in the effect body — a synchronous setState on mount cascades a
      // second render before the browser has laid anything out, and there is
      // nothing to measure that early anyway.
      if (!anchor) {
        setBox(null);
        return;
      }
      const el = document.querySelector(`[data-tour="${CSS.escape(anchor)}"]`);
      if (!el) {
        setBox(null);
        return;
      }
      const r = el.getBoundingClientRect();
      // A zero-size box means it is present but not laid out yet (collapsed, or
      // still loading). Treat it as absent rather than drawing a dot.
      if (r.width < 1 || r.height < 1) {
        setBox(null);
        return;
      }
      setBox({ top: r.top, left: r.left, width: r.width, height: r.height });
    };

    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };

    schedule();
    // Nothing to watch for when the step names no anchor.
    if (!anchor) return () => cancelAnimationFrame(raf);

    // The element usually arrives after the page's data does, so watch the DOM
    // rather than polling or measuring once and giving up.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [anchor]);

  return box;
}

/** Scroll an anchored element into view once, when a step becomes current. */
export function scrollAnchorIntoView(anchor: string | undefined): void {
  if (!anchor) return;
  const el = document.querySelector(`[data-tour="${CSS.escape(anchor)}"]`);
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
}
