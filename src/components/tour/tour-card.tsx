"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { X, ArrowLeft, ArrowRight, Sparkles, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDrawers } from "@/components/drawers/drawer-provider";
import { useTour } from "./tour-provider";

/**
 * The tour, as a card that sits over the real product.
 *
 * Deliberately NOT a modal and NOT a highlight-and-block overlay: the point is
 * that somebody reads the step and then looks at their own data underneath it,
 * so the page has to stay usable. It parks bottom-right, out of the way of the
 * sidebar and of most tables.
 *
 * Asking and feeding back both open the EXISTING drawers rather than growing
 * their own forms — one place in the product where feedback is written, one
 * assistant, and a tour that happens to open them with the step attached.
 */
export function TourCard({ orgSlug }: { orgSlug: string }) {
  const { tour, index, next, back, stop } = useTour();
  const { openDrawer } = useDrawers();
  const router = useRouter();
  const pathname = usePathname();

  const step = tour ? tour.steps[index] : null;
  const target = step?.href ? `/${orgSlug}${step.href}` : null;

  // Take them to the page the step is about. Only when they are not already
  // there — re-pushing the same route on every render would fight their
  // scrolling and make the page feel possessed.
  useEffect(() => {
    if (!target) return;
    if (pathname === target) return;
    router.push(target);
  }, [target, pathname, router]);

  if (!tour || !step) return null;

  const isLast = index === tour.steps.length - 1;

  return (
    <div
      role="complementary"
      aria-label={`${tour.name} tour, step ${index + 1} of ${tour.steps.length}`}
      className={cn(
        "fixed bottom-4 right-4 z-40 w-[min(24rem,calc(100vw-2rem))]",
        "rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg",
      )}
    >
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <div className="min-w-0">
          <p className="text-[0.65rem] uppercase tracking-wider text-[var(--text-muted)]">
            {tour.name} · {index + 1} of {tour.steps.length}
          </p>
          <p className="truncate text-sm font-semibold">{step.title}</p>
        </div>
        <Button variant="ghost" size="icon-xs" onClick={stop} aria-label="Close the tour">
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="px-4 py-3">
        <p className="mb-2 text-sm text-[var(--text-muted)]">{step.blurb}</p>
        <p className="rounded border-l-2 border-[var(--accent,currentColor)] bg-[var(--surface-hover)] px-3 py-2 text-sm">
          {step.look}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              openDrawer("assistant", {
                body: step.ask ?? `Tell me about "${step.title}".`,
                source: `tour:${tour.version}:${step.id}`,
              })
            }
          >
            <Sparkles className="mr-1 size-3.5" />
            Ask about this
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              openDrawer("feedback", {
                // The step goes in the body, not the title: a title somebody did
                // not write is a title they will send without reading.
                body: `\n\n— raised from the ${tour.name} tour, step "${step.title}"`,
                source: `tour:${tour.version}:${step.id}`,
              })
            }
          >
            <MessageSquarePlus className="mr-1 size-3.5" />
            Feedback
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-4 py-2.5">
        <Button variant="ghost" size="sm" onClick={back} disabled={index === 0}>
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
          <Button size="sm" onClick={stop}>
            Done
          </Button>
        ) : (
          <Button size="sm" onClick={next}>
            Next
            <ArrowRight className="ml-1 size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
