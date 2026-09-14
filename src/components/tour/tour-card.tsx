"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { X, ArrowLeft, ArrowRight, Sparkles, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDrawers } from "@/components/drawers/drawer-provider";
import { useTour } from "./tour-provider";
import { useAnchor, scrollAnchorIntoView } from "./use-anchor";
import { TourAsk } from "./tour-ask";
import { TourFeedback } from "./tour-feedback";

const CARD_W = 380;
const GAP = 16;

/**
 * The walkthrough, as a card over the real product.
 *
 * Deliberately not a modal: the point is that somebody reads the step and then
 * looks at their own data underneath it, so the page stays usable throughout.
 *
 * When a step names an anchor the card moves beside that element and rings it;
 * otherwise it parks bottom-right. Asking and feeding back happen IN the card,
 * because the drawer they used to open covered the very thing being pointed at.
 */
export function TourCard({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { tour, index, next, back, stop } = useTour();
  const { tool, width } = useDrawers();
  const router = useRouter();
  const pathname = usePathname();
  const [panel, setPanel] = useState<"none" | "ask" | "feedback">("none");

  const step = tour ? tour.steps[index] : null;
  const target = step?.href ? `/${orgSlug}${step.href}` : null;
  const box = useAnchor(step?.anchor);

  // Only when they are not already there: re-pushing the same route every
  // render would fight their scrolling and make the page feel possessed.
  useEffect(() => {
    if (!target || pathname === target) return;
    router.push(target);
  }, [target, pathname, router]);

  // Bring the anchored element into view once the step lands.
  useEffect(() => {
    if (!step?.anchor) return;
    const t = setTimeout(() => scrollAnchorIntoView(step.anchor), 350);
    return () => clearTimeout(t);
  }, [step?.anchor, index]);

  if (!tour || !step) return null;

  // Collapsing the panels belongs to the navigation itself: a half-typed
  // question about the previous step is not a question about this one. Done
  // here rather than in an effect watching the index, which would be a
  // cascading render for something already known at the click.
  const goNext = () => {
    setPanel("none");
    next();
  };
  const goBack = () => {
    setPanel("none");
    back();
  };

  const drawerInset = tool ? width : 0;
  const isLast = index === tour.steps.length - 1;

  // Beside the anchor when there is room to its right, otherwise to its left,
  // otherwise back to the corner. Clamped so the card is never half off-screen.
  let pos: { top?: number; left?: number; right?: number; bottom?: number };
  if (box) {
    const spaceRight = window.innerWidth - drawerInset - (box.left + box.width) - GAP;
    const left =
      spaceRight >= CARD_W
        ? box.left + box.width + GAP
        : Math.max(GAP, box.left - CARD_W - GAP);
    pos = {
      top: Math.max(GAP, Math.min(box.top, window.innerHeight - 320)),
      left: Math.min(left, window.innerWidth - drawerInset - CARD_W - GAP),
    };
  } else {
    pos = { bottom: 80, right: drawerInset + GAP };
  }

  return (
    <>
      {box && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-30 rounded-md ring-2 ring-[var(--text)] ring-offset-2 ring-offset-[var(--bg)] transition-all motion-reduce:transition-none"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
        />
      )}

      <div
        role="complementary"
        aria-label={`${tour.name} walkthrough, step ${index + 1} of ${tour.steps.length}`}
        style={{ ...pos, width: `min(${CARD_W}px, calc(100vw - 2rem))` }}
        className={cn(
          "fixed z-40 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg",
          "transition-all motion-reduce:transition-none",
        )}
      >
        <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] px-4 py-2.5">
          <div className="min-w-0">
            <p className="text-[0.65rem] uppercase tracking-wider text-[var(--text-muted)]">
              {tour.name} · {index + 1} of {tour.steps.length}
            </p>
            <p className="truncate text-sm font-semibold">{step.title}</p>
          </div>
          <Button variant="ghost" size="icon-xs" onClick={stop} aria-label="Close the walkthrough">
            <X className="size-3.5" />
          </Button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
          <p className="mb-2 text-sm text-[var(--text-muted)]">{step.blurb}</p>
          <p className="rounded border-l-2 border-[var(--text)] bg-[var(--surface-hover)] px-3 py-2 text-sm">
            {step.look}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant={panel === "ask" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setPanel((p) => (p === "ask" ? "none" : "ask"))}
            >
              <Sparkles className="mr-1 size-3.5" />
              Ask about this
            </Button>
            <Button
              variant={panel === "feedback" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setPanel((p) => (p === "feedback" ? "none" : "feedback"))}
            >
              <MessageSquarePlus className="mr-1 size-3.5" />
              Feedback
            </Button>
          </div>

          {panel === "ask" && <TourAsk orgId={orgId} step={step} tourName={tour.name} />}
          {panel === "feedback" && (
            <TourFeedback orgId={orgId} step={step} tourName={tour.name} tourId={tour.id} />
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-2.5">
          <Button variant="ghost" size="sm" onClick={goBack} disabled={index === 0}>
            <ArrowLeft className="mr-1 size-3.5" />
            Back
          </Button>
          <div className="flex gap-1" aria-hidden="true">
            {tour.steps.map((s, i) => (
              <span
                key={s.id}
                className={cn(
                  "h-1 w-4 rounded-full",
                  i === index ? "bg-[var(--text)]" : "bg-[var(--border)]",
                )}
              />
            ))}
          </div>
          {isLast ? (
            <Button size="sm" onClick={stop}>Done</Button>
          ) : (
            <Button size="sm" onClick={goNext}>
              Next
              <ArrowRight className="ml-1 size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
