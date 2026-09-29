"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { X, ArrowLeft, ArrowRight, Sparkles, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDrawers } from "@/components/drawers/drawer-provider";
import { useTour } from "./tour-provider";
import { usePermissions } from "@/components/providers/permissions-provider";
import { Permission } from "@/lib/rbac/permissions";
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
  const { can } = usePermissions();
  const canAsk = can(Permission.CHAT_USE);

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
  //
  // Started immediately and cancelled on the way out, because the helper waits
  // for the element itself: a step that changes page has nothing to scroll to
  // for several seconds, and the fixed delay this used to have expired long
  // before the new route had rendered.
  useEffect(() => {
    if (!step?.anchor) return;
    return scrollAnchorIntoView(step.anchor);
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
          // z-[85]: see the card below. The ring sits just under it so the card
          // always wins if they overlap, and it is pointer-events-none, so
          // being high in the stack costs nothing.
          className="pointer-events-none fixed z-[85] rounded-md ring-2 ring-[var(--text)] ring-offset-2 ring-offset-[var(--bg)] transition-all motion-reduce:transition-none"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
        />
      )}

      <div
        role="complementary"
        aria-label={`${tour.name} walkthrough, step ${index + 1} of ${tour.steps.length}`}
        style={{ ...pos, width: `min(${CARD_W}px, calc(100vw - 2rem))` }}
        className={cn(
          // z-[90] puts the walkthrough ABOVE every overlay in the app. The
          // ladder it has to clear: dialogs, sheets, dropdowns and tooltips at
          // z-50, the notes mention picker at 60, and two plugin overlays at 70
          // and 80. It stays under the skip link at 100, which must always win.
          //
          // It used to be z-40, i.e. under all of them. That is not a cosmetic
          // ordering choice: the card is the only way to advance or leave the
          // walkthrough, so anything that opened on top of it stranded the
          // reader with no visible control. The changelog dialog does exactly
          // that on first load after a release -- which is when a walkthrough
          // is most likely to be running.
          "fixed z-[90] rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg",
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
            {/* Offered only to somebody the assistant will actually answer. The
                endpoint requires CHAT_USE, which VIEWER does not hold — and a
                demo pass is a VIEWER by default, so without this the headline
                feature fails for exactly the reader it was built to impress. */}
            {canAsk && (
              <Button
                variant={panel === "ask" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setPanel((p) => (p === "ask" ? "none" : "ask"))}
              >
                <Sparkles className="mr-1 size-3.5" />
                Ask about this
              </Button>
            )}
            <Button
              variant={panel === "feedback" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setPanel((p) => (p === "feedback" ? "none" : "feedback"))}
            >
              <MessageSquarePlus className="mr-1 size-3.5" />
              Feedback
            </Button>
          </div>

          {panel === "ask" && canAsk && <TourAsk orgId={orgId} step={step} tourName={tour.name} />}
          {panel === "feedback" && (
            <TourFeedback orgId={orgId} step={step} tourName={tour.name} tourId={tour.id} />
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-2.5">
          <Button variant="ghost" size="sm" onClick={goBack} disabled={index === 0}>
            <ArrowLeft className="mr-1 size-3.5" />
            Back
          </Button>
          {/*
            One continuous bar rather than one dash per step. A dash each was
            fine at five or six steps and silently broke the card at sixty: 60
            dashes at w-4 plus gap-1 is about 1,200px of track inside a ~370px
            card, and with nothing to stop it growing it pushed Next clean off
            the edge. The tour still worked; there was simply no way to advance
            it. flex-1 with min-w-0 is what keeps that from ever recurring --
            the track now yields to Back and Next instead of crowding them out,
            at any length. Exact position stays legible from the "N of M" in
            the header, which is where a number belongs anyway.
          */}
          <div
            className="mx-2 h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--border)]"
            aria-hidden="true"
          >
            <div
              className="h-full rounded-full bg-[var(--text)] transition-[width] duration-200"
              style={{ width: `${((index + 1) / tour.steps.length) * 100}%` }}
            />
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
