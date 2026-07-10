"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CosmoGlyph } from "@/components/assistant/cosmo-avatar";
import { cn } from "@/lib/utils";
import { useDrawers } from "@/components/drawers/drawer-provider";
import { useBrand } from "@/components/providers/brand-provider";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { computeBubbleLift, type CollisionRect } from "./bubble-collision";

/**
 * Persistent floating agent affordance (item 9).
 *
 * A bottom-right bubble that opens the ONE docked Assistant drawer — the SAME
 * surface as the topbar ✨ trigger and the `cosmos:agent:open` event (mobile
 * bottom nav, command palette). Previously this hosted its OWN slide-over with
 * a different assistant component, which diverged from the topbar drawer; now
 * it's a pure entry point so the agent experience is identical everywhere.
 *
 * Rendered only when an org is in context (the drawer's panels need an orgId).
 * On mobile the bubble lifts above the bottom-nav safe area.
 *
 * ## Mobile collision avoidance
 *
 * On phones other *pinned* tappable controls can share the bottom-right corner —
 * the settings save/discard bar (a fixed, full-width bottom bar) or the sticky
 * bulk-action pills on boards/tables. When they do, the bubble covers their
 * buttons. We measure nearby pinned interactive elements and, if any overlap the
 * bubble's resting footprint, lift the bubble straight up just far enough to
 * clear them (see `computeBubbleLift`). Only pinned (fixed/sticky) controls are
 * considered — ordinary content that scrolls under a floating button is expected
 * and must not make the bubble jitter.
 */

const GAP = 8;
const MAX_LIFT = 260;
// Collision avoidance targets short pinned bars/pills, not full-height surfaces
// (drawers/sheets/modals). Anything taller than this share of the viewport is
// treated as such a surface and ignored.
const MAX_OBSTACLE_VIEWPORT_FRACTION = 0.45;

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='switch']",
  "[role='checkbox']",
].join(",");

/** Is `el` (or an ancestor) pinned to the viewport (position fixed/sticky)? */
function isPinned(el: HTMLElement | null): boolean {
  let node = el;
  for (let depth = 0; node && depth < 16; depth++) {
    const pos = getComputedStyle(node).position;
    if (pos === "fixed" || pos === "sticky") return true;
    node = node.parentElement;
  }
  return false;
}

export function FloatingAgentBubble({ orgId }: { orgId: string | undefined }) {
  const { open, isOpen } = useDrawers();
  const brand = useBrand();
  const isMobile = useMediaQuery("(max-width: 767px)");

  const btnRef = useRef<HTMLButtonElement>(null);
  // Mirror of `lift` state read inside `measure` so it can reconstruct the
  // bubble's resting rect (rendered rect + current lift) without depending on
  // the state value — keeps `measure` stable and free of feedback loops.
  const liftRef = useRef(0);
  const [lift, setLift] = useState(0);

  const hidden = !orgId || isOpen("assistant");

  // Let other surfaces (mobile bottom nav, command palette) open the agent.
  useEffect(() => {
    function onOpen() {
      open("assistant");
    }
    window.addEventListener("cosmos:agent:open", onOpen);
    return () => window.removeEventListener("cosmos:agent:open", onOpen);
  }, [open]);

  const measure = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    if (!isMobile) {
      // Desktop keeps its resting position (plenty of room; drawer reflows the
      // shell rather than overlapping).
      if (liftRef.current !== 0) {
        liftRef.current = 0;
        setLift(0);
      }
      return;
    }

    const rect = btn.getBoundingClientRect();
    // Reconstruct the resting rect by undoing the current lift (the bubble is
    // translated up by `liftRef.current`).
    const base: CollisionRect = {
      top: rect.top + liftRef.current,
      bottom: rect.bottom + liftRef.current,
      left: rect.left,
      right: rect.right,
    };

    const viewportH = window.innerHeight || 0;
    const searchTop = base.top - MAX_LIFT;
    const searchBottom = base.bottom + GAP;
    const colLeft = base.left - GAP;
    const colRight = base.right + GAP;

    const obstacles: CollisionRect[] = [];
    document
      .querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)
      .forEach((el) => {
        if (el === btn || btn.contains(el) || el.contains(btn)) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        // Skip full-height surfaces (drawers/sheets) — not corner bars.
        if (viewportH > 0 && r.height > viewportH * MAX_OBSTACLE_VIEWPORT_FRACTION) return;
        // Only controls sharing the bubble's column and near its resting height.
        if (r.right <= colLeft || r.left >= colRight) return;
        if (r.bottom <= searchTop || r.top >= searchBottom) return;
        // Only pinned overlays — scrolling content is meant to pass under a FAB.
        if (!isPinned(el)) return;
        obstacles.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      });

    const next = computeBubbleLift(base, obstacles, { gap: GAP, maxLift: MAX_LIFT });
    if (next !== liftRef.current) {
      liftRef.current = next;
      setLift(next);
    }
  }, [isMobile]);

  // Re-measure on anything that can change the layout under/around the bubble:
  // viewport resize, orientation change, scrolling (sticky bars move), and DOM
  // mutations (bars appearing/disappearing). Everything funnels through one
  // rAF-throttled tick. Inert while the bubble is hidden.
  useEffect(() => {
    if (hidden) return;

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };

    schedule();
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    // Capture so we also catch scrolls from the inner <main> scroller.
    window.addEventListener("scroll", schedule, true);

    const observer = new MutationObserver((records) => {
      const btn = btnRef.current;
      // Ignore our own translate writes so applying a lift can't re-trigger us.
      const onlySelf =
        btn != null &&
        records.every((r) => r.target === btn || (r.target instanceof Node && btn.contains(r.target)));
      if (onlySelf) return;
      schedule();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("scroll", schedule, true);
      observer.disconnect();
    };
  }, [hidden, measure]);

  if (hidden) return null;

  return (
    <button
      ref={btnRef}
      type="button"
      onClick={() => open("assistant")}
      aria-label={`Open ${brand.agentName}`}
      title={brand.agentName}
      // Lift is applied via the CSS `translate` property (independent of the
      // `scale` used by hover:scale-105, so they compose without conflict).
      style={lift > 0 ? { translate: `0 ${-lift}px` } : undefined}
      className={cn(
        "fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] right-4 z-40 md:bottom-6 md:right-6",
        "flex h-12 w-12 items-center justify-center rounded-full",
        "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-lg",
        "transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]",
      )}
    >
      <CosmoGlyph className="h-5 w-5" />
    </button>
  );
}
