"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDrawers } from "@/components/drawers/drawer-provider";
import { useBrand } from "@/components/providers/brand-provider";
import { domIsBlocked, pickOffset, restingBox, type Offset } from "./bubble-dodge";

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
 * It also moves out of the way of whatever it would cover: see
 * {@link useDodge}.
 */
export function FloatingAgentBubble({ orgId }: { orgId: string | undefined }) {
  const { open, isOpen } = useDrawers();
  const brand = useBrand();

  // Let other surfaces (mobile bottom nav, command palette) open the agent.
  useEffect(() => {
    function onOpen() {
      open("assistant");
    }
    window.addEventListener("cosmos:agent:open", onOpen);
    return () => window.removeEventListener("cosmos:agent:open", onOpen);
  }, [open]);

  const hidden = !orgId || isOpen("assistant");
  const { ref, offset } = useDodge(!hidden);

  // Hide the bubble while the assistant drawer is already open (its own header
  // has the close control) so they don't overlap.
  if (hidden) return null;

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => open("assistant")}
      aria-label={`Open ${brand.agentName}`}
      title={brand.agentName}
      className={cn(
        "fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] right-4 z-40 md:bottom-6 md:right-6",
        "flex h-12 w-12 items-center justify-center rounded-full",
        "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-lg",
        // Only `scale` transitions (for hover). The dodge offset must NOT animate:
        // see useDodge — an in-flight `translate` made every re-check measure a
        // position the bubble had not reached yet.
        "transition-[scale] duration-200 motion-reduce:transition-none hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]",
      )}
      // `translate` (not `transform`) so it composes with hover:scale.
      style={offset.x || offset.y ? { translate: `${offset.x}px ${offset.y}px` } : undefined}
    >
      <Sparkles className="h-5 w-5" />
    </button>
  );
}

/**
 * Re-picks the bubble's slot whenever what lies beneath it can change: scroll
 * (any scroller, so capture phase), resize and rotation, content added or
 * removed, and layout growing or shrinking. Checks are coalesced to one per
 * frame and at most ~8 a second.
 *
 * The resting box is measured so that it does NOT depend on the transform
 * currently applied to the bubble. It used to be `getBoundingClientRect()`
 * minus the applied offset, which made the measurement a function of animation
 * state, and the throttle (120ms) is SHORTER than the old transition (200ms),
 * so a re-check landing mid-move was the normal case rather than an edge one.
 * Such a check computed a resting box off by the untravelled remainder, which
 * shifted every candidate slot and all nine sample points, hit-tested the wrong
 * pixels, and so returned a different slot -- which started another move, and
 * another mistimed check. The bubble darted around the screen instead of
 * settling (feedback item 46d8ea78).
 *
 * Two things keep it settled: the dodge offset is not animated (only `scale`
 * is, for hover), and the size comes from the UNTRANSFORMED layout box, so
 * `hover:scale-105` cannot shift the sample points either. Together those make
 * repeated checks over an unchanged page idempotent, which is the property the
 * tests pin.
 */
function useDodge(active: boolean) {
  const ref = useRef<HTMLButtonElement>(null);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const current = useRef<Offset>({ x: 0, y: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!active || !el || typeof document.elementsFromPoint !== "function") return;

    let frame = 0;
    let last = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;

    const check = () => {
      frame = 0;
      last = performance.now();
      // Measure the RESTING spot, independent of the transform applied.
      const rest = restingBox(
        el.getBoundingClientRect(),
        el.offsetWidth,
        el.offsetHeight,
        current.current,
      );
      const next = pickOffset(rest, window.innerWidth, domIsBlocked(el));
      if (next.x !== current.current.x || next.y !== current.current.y) {
        current.current = next;
        setOffset(next);
      }
    };
    const schedule = () => {
      if (frame) return;
      const wait = 120 - (performance.now() - last);
      if (wait > 0) {
        clearTimeout(trailing);
        trailing = setTimeout(schedule, wait);
        return;
      }
      frame = requestAnimationFrame(check);
    };

    schedule();
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    // Content swaps (route changes, lists loading) — childList only, so the
    // bubble's own style change never re-triggers it.
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    ro?.observe(document.body);

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(trailing);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      mo.disconnect();
      ro?.disconnect();
    };
  }, [active]);

  return { ref, offset };
}
